//! 16-B SetGamingKBBacklightEffect frame (controller-DLL layout).
//!
//! Byte-locked parity: byte-identical output of python `_kb_frame` in
//! src/psensed (ledger section 13.14; live-verified on PHN16-71
//! 2026-10-19). Layout:
//!
//! ```text
//! [0]=mode          EC mode id (0 STATIC, 1 BREATHING, 4 SHIFTING,
//!                   6 METEOR, 7 TWINKLING; 0xFF DIRECT)
//! [1]=speed         0..255 (kb.set forces 0 for STATIC/DIRECT)
//! [2]=brightness    0..255 luminosity byte
//! [3]=direction+1   python daemon writes dir_plus_one = dir + 1
//!                   (callers pre-clamp dir to 0..15; effect path uses 1|2)
//! [4..6]=R,G,B      EC consumes these for animated modes (STATIC shows
//!                   the id-6 zone store instead)
//! [7]=0 reserved
//! [8]=0x03          on-flag byte
//! [9]=device        1 = keyboard
//! [10..15]=0        reserved
//! ```

/// EC-native mode ids from the AcerECKeyboardController mode table.
///
/// WAVE / RAINBOW / NEON are strip-only ids: the alias pass maps them
/// away first (`EcEffect::resolve`), so they never reach the frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct EcModeId(pub u8);

impl EcModeId {
    pub const STATIC: EcModeId = EcModeId(0);
    pub const DIRECT: EcModeId = EcModeId(0xFF);
    pub const BREATHING: EcModeId = EcModeId(1);
    pub const SHIFTING: EcModeId = EcModeId(4);
    pub const METEOR: EcModeId = EcModeId(6);
    pub const TWINKLING: EcModeId = EcModeId(7);
}

/// EC-native effect names accepted by the frame path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EcEffect {
    Breathing,
    Shifting,
    Meteor,
    Twinkling,
}

impl EcEffect {
    pub fn mode(self) -> EcModeId {
        match self {
            EcEffect::Breathing => EcModeId::BREATHING,
            EcEffect::Shifting => EcModeId::SHIFTING,
            EcEffect::Meteor => EcModeId::METEOR,
            EcEffect::Twinkling => EcModeId::TWINKLING,
        }
    }

    /// Replica of `_kb_apply_effect`'s resolution: uppercase the name,
    /// pass the aliases through (RAINBOW -> WAVE, NEON -> SHIFTING), then
    /// look the id up in the EC table. None means the effect stays on the
    /// userspace software engine (WAVE/SCREEN/MUSIC/...).
    pub fn resolve(name: &str) -> Option<EcEffect> {
        let eff = name.to_ascii_uppercase();
        let eff = match eff.as_str() {
            "RAINBOW" => "WAVE",
            "NEON" => "SHIFTING",
            other => other,
        };
        match eff {
            "BREATHING" => Some(EcEffect::Breathing),
            "SHIFTING" => Some(EcEffect::Shifting),
            "METEOR" => Some(EcEffect::Meteor),
            "TWINKLING" => Some(EcEffect::Twinkling),
            _ => None,
        }
    }
}

/// The 16-B controller-DLL frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KbFrame {
    pub mode: u8,
    pub speed: u8,
    pub brightness: u8,
    /// raw direction value BEFORE the +1 the frame encoding adds
    pub direction: u8,
    pub rgb: [u8; 3],
    pub device: u8,
}

/// One channel of the python generator: `max(0, min(255, int(c)))`.
fn clamp_channel(c: i32) -> u8 {
    c.clamp(0, 255) as u8
}

impl KbFrame {
    /// Build from resolved byte fields (python parity: rgb clamped to
    /// 0..255 per channel, byte fields masked to u8).
    pub fn new(
        mode: u8,
        speed: u8,
        brightness: u8,
        direction: u8,
        rgb: [i32; 3],
        device: u8,
    ) -> KbFrame {
        // (python's `& 0xFF` masks disappear here: every field is a u8 by
        // construction, so the types already carry the python masking)
        KbFrame {
            mode,
            speed,
            brightness,
            direction,
            rgb: [clamp_channel(rgb[0]), clamp_channel(rgb[1]), clamp_channel(rgb[2])],
            device,
        }
    }

    /// STATIC/DIRECT normalization replica from `kb.set`: the EC ignores
    /// speed != 0 on modes 0 and 0xFF, so the daemon forces speed 0.
    pub fn new_normalized_static(
        mode: u8,
        speed: u8,
        brightness: u8,
        direction: u8,
        rgb: [i32; 3],
        device: u8,
    ) -> KbFrame {
        let speed = if mode == EcModeId::STATIC.0 || mode == EcModeId::DIRECT.0 {
            0
        } else {
            speed
        };
        KbFrame::new(mode, speed, brightness, direction, rgb, device)
    }

    /// Wire bytes [16]: `[mode, speed, bri, dir+1, r, g, b, 0, 0x03, device, 0*6]`.
    pub fn frame_bytes(&self) -> [u8; 16] {
        let dir_plus_one = self.direction.wrapping_add(1);
        [
            self.mode,
            self.speed,
            self.brightness,
            dir_plus_one,
            self.rgb[0],
            self.rgb[1],
            self.rgb[2],
            0x00,
            0x03,
            self.device,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
        ]
    }

    /// Lowercase hex, the exact representation the daemon reports in the
    /// `frame` field of kb.set / kb.effect.set acknowledgements.
    pub fn to_hex(&self) -> String {
        let b = self.frame_bytes();
        let mut s = String::with_capacity(32);
        for byte in b {
            s.push_str(&format!("{:02x}", byte));
        }
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_verified_static_vector() {
        // Live run 2026-10-20 (feat/hardening verification):
        // `psense kb set static --brightness 200 --rgb 0,180,255`
        // acknowledged frame "0000c80100b4ff000301000000000000".
        // python path: kb.set -> mode 0 (& 0xFF), speed forced 0 for
        // STATIC, bri 200 (0xc8), dir 0 -> +1 -> 0x01, rgb clamped
        // 0,180,255 (b4=180 ff=255), on-flag 0x03, device 1.
        let f = KbFrame::new_normalized_static(0, 9, 200, 0, [0, 180, 255], 1);
        assert_eq!(
            f.to_hex(),
            "0000c80100b4ff000301000000000000"
        );
    }

    #[test]
    fn calibration_probe_vector() {
        // Ledger recalibration probe 2026-10-19: method-20 write of
        // mode 1 / speed 3 / bri 100 / rgb C7,3E,14 / dir 1. The
        // method-21 readback echo ([1]=mode [2]=speed [3]=bri [4]=dir
        // [5..7]=rgb) confirms the write landed with this frame.
        let f = KbFrame::new(1, 3, 100, 1, [0xc7, 0x3e, 0x14], 1);
        assert_eq!(f.to_hex(), "01036402c73e14000301000000000000");
    }

    #[test]
    fn direction_plus_byte() {
        // effect callers pass dir 1 (right) -> byte 2; dir 2 (left) -> 3;
        // kb.set callers may pass 0 (static) -> byte 1
        assert_eq!(KbFrame::new(1, 3, 100, 1, [0, 0, 0], 1).frame_bytes()[3], 2);
        assert_eq!(KbFrame::new(1, 3, 100, 2, [0, 0, 0], 1).frame_bytes()[3], 3);
        assert_eq!(KbFrame::new(0, 0, 100, 0, [0, 0, 0], 1).frame_bytes()[3], 1);
    }

    #[test]
    fn rgb_and_device_clamping() {
        let f = KbFrame::new(0, 0, 100, 0, [-5, 300, 999], 77);
        assert_eq!(f.rgb, [0, 255, 255]);
        assert_eq!(f.frame_bytes()[9], 77);
    }

    #[test]
    fn static_speed_force() {
        let f = KbFrame::new_normalized_static(255, 5, 100, 0, [0, 0, 0], 1);
        assert_eq!(f.frame_bytes()[0], 0xFF);
        assert_eq!(f.frame_bytes()[1], 0); // DIRECT forces speed 0
        let f2 = KbFrame::new_normalized_static(1, 5, 100, 1, [0, 0, 0], 1);
        assert_eq!(f2.frame_bytes()[1], 5); // animated keeps speed
    }

    #[test]
    fn effect_resolution_table() {
        // EC-native names
        assert_eq!(EcEffect::resolve("breathing"), Some(EcEffect::Breathing));
        assert_eq!(EcEffect::resolve("METEOR"), Some(EcEffect::Meteor));
        assert_eq!(EcEffect::resolve("Twinkling"), Some(EcEffect::Twinkling));
        // alias pass BEFORE the lookup
        assert_eq!(EcEffect::resolve("neon"), Some(EcEffect::Shifting));
        // aliases leave the strip-only names OFF the EC table
        assert_eq!(EcEffect::resolve("RAINBOW"), None);
        assert_eq!(EcEffect::resolve("wave"), None);
        assert_eq!(EcEffect::resolve("screen"), None);
        assert_eq!(EcEffect::resolve("music"), None);
        assert_eq!(EcEffect::resolve("nope"), None);

        assert_eq!(EcEffect::Meteor.mode(), EcModeId::METEOR);
        assert_eq!(EcEffect::Breathing.mode(), EcModeId::BREATHING);
        assert_eq!(EcEffect::Shifting.mode().0, 4);
        assert_eq!(EcEffect::Twinkling.mode().0, 7);
    }
}
