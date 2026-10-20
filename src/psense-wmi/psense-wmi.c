// SPDX-License-Identifier: GPL-2.0-only
/*
 * psense-wmi - controlled WMI evaluation proxy for Acer Predator gaming surfaces
 *
 * Exposes a root-only misc chardev /dev/psense-wmi with one ioctl:
 *
 *   PSWMI_EVAL  - evaluate a whitelisted WMI method and return the raw bytes
 *   PSWMI_INFO  - report which whitelisted GUIDs are bound and their counts
 *
 * The driver core binds the whitelisted GUIDs directly (drivers/platform/x86/wmi);
 * evaluation goes through wmidev_invoke_method(), i.e. the same AML calls the
 * Windows PredatorSense binaries perform via COM ExecMethod (see spec/protocol.md).
 *
 * Whitelist v1 (set/method-id space):
 *   7A4DDFE7-5B5D-40B4-8595-4408E0CC7F56  AcerGamingFunction   ids 2..23 (24/25 OC + id 1 blocked)
 *   61EF69EA-865C-4BC3-A502-A0DEBA0CB531  APGeAction           ids 1,2
 *   79772EC5-04B1-4BFD-843C-61E7F77B6CC9  BatteryControl       ids 19..23
 *   1EA0BC57-521E-461B-A7A9-5D36F141A82A  AcerGenericMethod    ids 2,3 (reads only)
 *
 * Excluded by design: password/BIOS-settings surfaces (UtilityFunction FE1DBBDA,
 * BIOSSetting F75F5666, DataTrans 9F98130E, AcerBiosConfigurationTool 4BB53443).
 *
 * Pacing honors Acer's >=30 ms firmware rule globally (including between two
 * processes): the first eval after another one sleeps out the remainder.
 */

#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/miscdevice.h>
#include <linux/fs.h>
#include <linux/uaccess.h>
#include <linux/mutex.h>
#include <linux/ktime.h>
#include <linux/delay.h>
#include <linux/slab.h>
#include <linux/string.h>
#include <linux/uio.h>
#include <linux/wmi.h>

#define PSWMI_MAX_BUF		4096
#define PSWMI_MIN_GAP_NS	(30ull * NSEC_PER_MSEC)

/* GUID selector indices (user <-> kernel ABI; stable) */
#define PSWMI_GUID_GAMING	0	/* AcerGamingFunction 7A4DDFE7 */
#define PSWMI_GUID_APGE		1	/* APGeAction 61EF69EA */
#define PSWMI_GUID_BATTERY	2	/* BatteryControl 79772EC5 */
#define PSWMI_GUID_GENERIC	3	/* AcerGenericMethod 1EA0BC57 */
#define PSWMI_GUID_MAX		4

static const char *pswmi_guids[PSWMI_GUID_MAX] = {
	"7A4DDFE7-5B5D-40B4-8595-4408E0CC7F56",
	"61EF69EA-865C-4BC3-A502-A0DEBA0CB531",
	"79772EC5-04B1-4BFD-843C-61E7F77B6CC9",
	"1EA0BC57-521E-461B-A7A9-5D36F141A82A",
};

/* per-GUID allowed WmiMethodId bitmaps (bit n set => id n allowed) */
static const u32 pswmi_allow[PSWMI_GUID_MAX] = {
	/* gaming: ids 2..23 (id 1 duplicates sysfs profile writes; 24/25 OC
	   structures blocked until their 512-byte layout is decoded) */
	[PSWMI_GUID_GAMING]	= 0x00FFFFFC,
	/* APGeAction: SetFunction(1) / GetFunction(2) */
	[PSWMI_GUID_APGE]	= 0x00000007,
	/* BatteryControl: GetBattInfoInterface(19) GetBatteryHealthControlStatus(20)
	   SetBatteryHealthControl(21) Get/SetBatteryFunctionData(22,23) */
	[PSWMI_GUID_BATTERY]	= 0x00F80000,
	/* AcerGenericMethod: GetFunction(2) + GetStorageInformation(3) reads only */
	[PSWMI_GUID_GENERIC]	= 0x0000000C,
};

struct pswmi_wdev {
	struct wmi_device	*wdev;
	bool			bound;
};

static struct pswmi_wdev pswmi_devs[PSWMI_GUID_MAX];
static DEFINE_MUTEX(pswmi_lock);	/* protects bound[] and serializes evals */
static ktime_t pswmi_last_eval;

struct pswmi_eval {			/* PSWMI_EVAL argument */
	__u32 guid;			/* PSWMI_GUID_* */
	__u32 method_id;
	__u32 in_len;
	__u32 out_len;
	__u32 out_used;			/* [out] bytes ACPI reports written */
	__u32 instance;			/* WMI instance index (usually 0) */
	__aligned_u64 in_ptr;		/* user pointer to in_len bytes */
	__aligned_u64 out_ptr;		/* user pointer to out_len bytes */
	__aligned_u64 status;		/* [out] acpi_status of the call */
};

struct pswmi_info {			/* PSWMI_INFO argument */
	__u32 bound_mask;		/* bit n set => GUID n bound */
	__u32 instance_count[PSWMI_GUID_MAX];
};

#define PSWMI_IOCTL_BASE	'P'
#define PSWMI_EVAL		_IOWR(PSWMI_IOCTL_BASE, 0x01, struct pswmi_eval)
#define PSWMI_INFO		_IOR(PSWMI_IOCTL_BASE, 0x02, struct pswmi_info)

static int pswmi_find_slot(struct wmi_device *wdev, const char *name)
{
	int i;

	for (i = 0; i < PSWMI_GUID_MAX; i++)
		if (strncmp(name, pswmi_guids[i], UUID_STRING_LEN) == 0)
			return i;

	return -1;
}

static int pswmi_probe(struct wmi_device *wdev, const void *context)
{
	int slot = pswmi_find_slot(wdev, dev_name(&wdev->dev));
	u8 count = wmidev_instance_count(wdev);

	if (slot < 0)
		return -ENODEV;

	mutex_lock(&pswmi_lock);
	pswmi_devs[slot].wdev = wdev;
	pswmi_devs[slot].bound = true;
	mutex_unlock(&pswmi_lock);

	dev_info(&wdev->dev, "psense-wmi: bound %s (instances=%u)\n",
		 pswmi_guids[slot], count);

	return 0;
}

static void pswmi_remove(struct wmi_device *wdev)
{
	int slot = pswmi_find_slot(wdev, dev_name(&wdev->dev));

	if (slot < 0)
		return;

	mutex_lock(&pswmi_lock);
	pswmi_devs[slot].wdev = NULL;
	pswmi_devs[slot].bound = false;
	mutex_unlock(&pswmi_lock);

	pr_info("psense-wmi: unbound %s\n", pswmi_guids[slot]);
}

static const struct wmi_device_id pswmi_id_table[] = {
	{ .guid_string = "7A4DDFE7-5B5D-40B4-8595-4408E0CC7F56", .context = NULL },
	{ .guid_string = "61EF69EA-865C-4BC3-A502-A0DEBA0CB531", .context = NULL },
	{ .guid_string = "79772EC5-04B1-4BFD-843C-61E7F77B6CC9", .context = NULL },
	{ .guid_string = "1EA0BC57-521E-461B-A7A9-5D36F141A82A", .context = NULL },
	{ }
};
MODULE_DEVICE_TABLE(wmi, pswmi_id_table);

static struct wmi_driver pswmi_driver = {
	.driver		= {
		.name	= "psense-wmi",
	},
	.id_table	= pswmi_id_table,
	/* coexist with acer_wmi if it holds any of these GUIDs */
	.no_singleton	= true,
	.probe		= pswmi_probe,
	.remove		= pswmi_remove,
};

static long pswmi_ioctl_info(struct pswmi_info __user *ui)
{
	struct pswmi_info info = { 0 };
	int i;

	for (i = 0; i < PSWMI_GUID_MAX; i++) {
		if (pswmi_devs[i].bound) {
			info.bound_mask |= BIT(i);
			if (pswmi_devs[i].wdev)
				info.instance_count[i] =
					wmidev_instance_count(pswmi_devs[i].wdev);
		}
	}

	return copy_to_user(ui, &info, sizeof(info)) ? -EFAULT : 0;
}

static long pswmi_ioctl_eval(struct pswmi_eval __user *uarg)
{
	struct pswmi_eval arg;
	struct wmi_buffer in = { 0 }, out = { 0 };
	void *inbuf = NULL;
	u64 status = 0;
	int ret, slot;
	long copied;

	if (copy_from_user(&arg, uarg, sizeof(arg)))
		return -EFAULT;

	slot = arg.guid;
	if (slot < 0 || slot >= PSWMI_GUID_MAX)
		return -EINVAL;
	if (!pswmi_devs[slot].bound || !pswmi_devs[slot].wdev)
		return -ENODEV;
	if (arg.method_id > 31 || !(pswmi_allow[slot] & BIT(arg.method_id)))
		return -EACCES;
	if (arg.in_len > PSWMI_MAX_BUF || arg.out_len > PSWMI_MAX_BUF)
		return -E2BIG;
	if (arg.instance > 0xff)
		return -EINVAL;
	if (arg.in_len && !arg.in_ptr)
		return -EFAULT;
	if (arg.out_len && !arg.out_ptr)
		return -EFAULT;

	if (arg.in_len) {
		inbuf = memdup_user(u64_to_user_ptr(arg.in_ptr), arg.in_len);
		if (IS_ERR(inbuf))
			return PTR_ERR(inbuf);
		in.length = arg.in_len;
		in.data = inbuf;
	}

	/*
	 * No caller-provided output buffer: wmidev_invoke_method() ignores the
	 * initial contents of @out and returns its own allocation holding the
	 * method result on success.
	 */

	mutex_lock(&pswmi_lock);

	/* honor the vendor's >=30 ms firmware pacing across all callers */
	{
		ktime_t now = ktime_get();
		s64 delta = ktime_to_ns(ktime_sub(now, pswmi_last_eval));

		if (delta >= 0 && delta < PSWMI_MIN_GAP_NS)
			usleep_range(PSWMI_MIN_GAP_NS - delta,
				     PSWMI_MIN_GAP_NS - delta + 1000);
		pswmi_last_eval = ktime_get();
	}

	ret = wmidev_invoke_method(pswmi_devs[slot].wdev, arg.instance,
				   arg.method_id, &in, &out, 0);
	status = ret;			/* 0 = ACPI success, else negative errno */
	if (ret == 0)
		ret = 0;

	mutex_unlock(&pswmi_lock);

	if (ret == 0) {
		/*
		 * wmidev_invoke_method() overwrites @out with its own
		 * allocation (data == ZERO_SIZE_PTR when the AML returned no
		 * object); the result must be copied from there, never from a
		 * buffer we allocated ourselves.
		 */
		void *res = (unsigned long)out.data > (unsigned long)ZERO_SIZE_PTR ?
			    out.data : NULL;

		copied = out.length;
		if (copied > arg.out_len)
			copied = arg.out_len;

		if (res && copied > 0 &&
		    copy_to_user(u64_to_user_ptr(arg.out_ptr), res, copied)) {
			ret = -EFAULT;
			copied = 0;
		}

		kfree(res);
	} else {
		copied = 0;
	}

	arg.out_used = ret == 0 ? (u32)max_t(long, copied, 0) : 0;

	arg.status = status;

	kfree(inbuf);

	if (copy_to_user(uarg, &arg, sizeof(arg)))
		return -EFAULT;

	return ret;
}

static long pswmi_ioctl(struct file *file, unsigned int cmd, unsigned long argp)
{
	if (!capable(CAP_SYS_ADMIN))
		return -EPERM;

	switch (cmd) {
	case PSWMI_EVAL:
		return pswmi_ioctl_eval((struct pswmi_eval __user *)argp);
	case PSWMI_INFO:
		return pswmi_ioctl_info((struct pswmi_info __user *)argp);
	default:
		return -ENOTTY;
	}
}

static const struct file_operations pswmi_fops = {
	.owner		= THIS_MODULE,
	.unlocked_ioctl	= pswmi_ioctl,
#ifdef CONFIG_COMPAT
	.compat_ioctl	= pswmi_ioctl,
#endif
};

static struct miscdevice pswmi_misc = {
	.minor	= MISC_DYNAMIC_MINOR,
	.name	= "psense-wmi",
	.fops	= &pswmi_fops,
	.mode	= 0600,
};

static int __init pswmi_init(void)
{
	int ret;

	ret = wmi_driver_register(&pswmi_driver);
	if (ret) {
		pr_err("psense-wmi: wmi_driver_register failed: %d\n", ret);
		return ret;
	}

	ret = misc_register(&pswmi_misc);
	if (ret) {
		wmi_driver_unregister(&pswmi_driver);
		pr_err("psense-wmi: misc_register failed: %d\n", ret);
		return ret;
	}

	pr_info("psense-wmi: /dev/%s ready (%d GUIDs whitelisted)\n",
		pswmi_misc.name, PSWMI_GUID_MAX);

	return 0;
}

static void __exit pswmi_exit(void)
{
	misc_deregister(&pswmi_misc);
	wmi_driver_unregister(&pswmi_driver);
	pr_info("psense-wmi: unloaded\n");
}

module_init(pswmi_init);
module_exit(pswmi_exit);

MODULE_AUTHOR("predator-sense-linux");
MODULE_DESCRIPTION("Acer Predator WMI evaluation proxy (whitelisted GUID/method surfaces)");
MODULE_VERSION("0.2.0");
MODULE_LICENSE("GPL");
