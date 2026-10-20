obj-m := psense-wmi.o

# kernelver is exported by DKMS when building against a specific kernel
KVER := $(if $(kernelver),$(kernelver),$(shell uname -r))
KDIR ?= /lib/modules/$(KVER)/build
PWD := $(shell pwd)

all: modules

modules:
	$(MAKE) -C $(KDIR) M=$(PWD) modules

clean:
	$(MAKE) -C $(KDIR) M=$(PWD) clean

install: modules
	sudo insmod psense-wmi.ko

remove:
	sudo rmmod psense-wmi
