//! A minimal ISO 9660 + Rock Ridge writer for cloud-init NoCloud seeds.
//!
//! The VM tier's seed is two small text files (`user-data`, `meta-data`) on a
//! volume labelled `cidata`. Linux builds that image with whichever of
//! `genisoimage` / `mkisofs` / `xorriso` / `cloud-localds` is installed; macOS
//! has `hdiutil` but no mkisofs, and a Windows QEMU install ships nothing at
//! all. Rather than ask each user to hunt for a tool, this writes the image
//! itself — the format for "a handful of files in the root directory" is
//! small and fixed, and the guest's kernel `isofs` driver is the only reader
//! that matters.
//!
//! What is written, and why each part is there:
//! - A Primary Volume Descriptor with the volume id as given (cloud-init
//!   matches the `cidata` label case-insensitively via blkid).
//! - One root directory, one sector, holding `.`/`..` and a record per file.
//! - **Rock Ridge** `SP` on the root's `.` record (the marker `isofs` needs
//!   before it honours any RR entry — without it names come back as
//!   `USER_DAT.;1`), plus `NM` (the real, mixed-case, hyphenated name) and
//!   `PX` (mode/uid/gid) on every record. No Joliet: a second directory tree
//!   buys nothing the guest reads.
//! - L and M path tables, because the spec requires them; `isofs` ignores both.
//!
//! Level-1 ISO names are 8.3 uppercase; `NM` carries the true name, so the
//! ISO name only has to be unique, which [`iso_name`] guarantees by index.
//! Pure over its inputs (`write_iso` returns the bytes), so the layout is unit
//! tested byte-for-byte and — where `isoinfo` is installed — cross-checked
//! against a reference reader.

const SECTOR: usize = 2048;
/// System area (16 sectors), PVD, terminator, L table, M table, root dir.
const PVD_LBA: u32 = 16;
const TERMINATOR_LBA: u32 = 17;
const L_TABLE_LBA: u32 = 18;
const M_TABLE_LBA: u32 = 19;
const ROOT_LBA: u32 = 20;
const FIRST_FILE_LBA: u32 = 21;

/// Build an ISO 9660 image holding `files` (name, bytes) in its root
/// directory under volume id `volume_id`. Names must be non-empty; more files
/// than fit one directory sector is an error (the seed has two).
pub fn write_iso(volume_id: &str, files: &[(&str, &[u8])]) -> Result<Vec<u8>, String> {
    if files.iter().any(|(name, _)| name.is_empty() || name.len() > 200) {
        return Err("iso9660: file names must be 1..=200 bytes".to_string());
    }

    // Lay the files out after the root directory, each on a sector boundary.
    let mut extents: Vec<(u32, u32)> = Vec::with_capacity(files.len()); // (lba, len)
    let mut next = FIRST_FILE_LBA;
    for (_, data) in files {
        let len = u32::try_from(data.len()).map_err(|_| "iso9660: file too large".to_string())?;
        extents.push((next, len));
        next += sectors_for(data.len());
    }
    let total_sectors = next;

    // Root directory: `.`, `..`, then one record per file.
    let mut root = Vec::with_capacity(SECTOR);
    root.extend(dir_record(ROOT_LBA, SECTOR as u32, true, &[0x00], &[sp_entry(), px_entry(0o040755)]));
    root.extend(dir_record(ROOT_LBA, SECTOR as u32, true, &[0x01], &[px_entry(0o040755)]));
    for (i, ((name, _), &(lba, len))) in files.iter().zip(&extents).enumerate() {
        let iso = iso_name(i);
        root.extend(dir_record(lba, len, false, iso.as_bytes(), &[nm_entry(name), px_entry(0o100644)]));
    }
    if root.len() > SECTOR {
        return Err("iso9660: too many files for a one-sector root directory".to_string());
    }
    root.resize(SECTOR, 0);

    let mut image = vec![0u8; FIRST_FILE_LBA as usize * SECTOR];
    image[PVD_LBA as usize * SECTOR..][..SECTOR].copy_from_slice(&primary_volume_descriptor(volume_id, total_sectors));
    {
        let term = &mut image[TERMINATOR_LBA as usize * SECTOR..][..SECTOR];
        term[0] = 255;
        term[1..6].copy_from_slice(b"CD001");
        term[6] = 1;
    }
    image[L_TABLE_LBA as usize * SECTOR..][..10].copy_from_slice(&path_table(true));
    image[M_TABLE_LBA as usize * SECTOR..][..10].copy_from_slice(&path_table(false));
    image[ROOT_LBA as usize * SECTOR..][..SECTOR].copy_from_slice(&root);
    for (_, data) in files {
        image.extend_from_slice(data);
        let pad = sectors_for(data.len()) as usize * SECTOR - data.len();
        image.extend(std::iter::repeat_n(0u8, pad));
    }
    debug_assert_eq!(image.len(), total_sectors as usize * SECTOR);
    Ok(image)
}

fn sectors_for(len: usize) -> u32 {
    (len.div_ceil(SECTOR).max(1)) as u32
}

/// `FILE_<i>.;1` — unique, level-1 legal, and irrelevant to the guest, which
/// reads the `NM` name instead.
fn iso_name(index: usize) -> String {
    format!("FILE_{index}.;1")
}

fn both_u16(v: u16) -> [u8; 4] {
    let le = v.to_le_bytes();
    let be = v.to_be_bytes();
    [le[0], le[1], be[0], be[1]]
}

fn both_u32(v: u32) -> [u8; 8] {
    let mut out = [0u8; 8];
    out[..4].copy_from_slice(&v.to_le_bytes());
    out[4..].copy_from_slice(&v.to_be_bytes());
    out
}

/// A fixed recording date: the seed's timestamp carries no information and a
/// stable value keeps the image reproducible for the same inputs.
fn record_date() -> [u8; 7] {
    // 2024-01-01 00:00:00 UTC, years since 1900.
    [124, 1, 1, 0, 0, 0, 0]
}

/// One directory record. `system_use` entries are appended verbatim after the
/// identifier (and its pad byte, which keeps the system-use area at an even
/// offset as the spec requires). The record length is even by construction.
fn dir_record(lba: u32, len: u32, dir: bool, ident: &[u8], system_use: &[Vec<u8>]) -> Vec<u8> {
    let mut r = Vec::with_capacity(64);
    r.push(0); // length, patched below
    r.push(0); // extended attribute length
    r.extend(both_u32(lba));
    r.extend(both_u32(len));
    r.extend(record_date());
    r.push(if dir { 0x02 } else { 0x00 });
    r.push(0); // file unit size
    r.push(0); // interleave gap
    r.extend(both_u16(1)); // volume sequence number
    r.push(ident.len() as u8);
    r.extend_from_slice(ident);
    if ident.len().is_multiple_of(2) {
        r.push(0);
    }
    for entry in system_use {
        r.extend_from_slice(entry);
    }
    if r.len() % 2 == 1 {
        r.push(0);
    }
    r[0] = r.len() as u8;
    r
}

/// SUSP `SP`: "Rock Ridge is in use here", on the root `.` record only.
fn sp_entry() -> Vec<u8> {
    vec![b'S', b'P', 7, 1, 0xBE, 0xEF, 0]
}

/// RRIP `NM`: the POSIX file name.
fn nm_entry(name: &str) -> Vec<u8> {
    let mut e = vec![b'N', b'M', (5 + name.len()) as u8, 1, 0];
    e.extend_from_slice(name.as_bytes());
    e
}

/// RRIP 1.12 `PX`: mode, link count, uid, gid, serial (44 bytes).
fn px_entry(mode: u32) -> Vec<u8> {
    let mut e = vec![b'P', b'X', 44, 1];
    e.extend(both_u32(mode));
    e.extend(both_u32(1)); // links
    e.extend(both_u32(0)); // uid
    e.extend(both_u32(0)); // gid
    e.extend(both_u32(0)); // serial
    e
}

/// The single root entry of a path table (little-endian for L, big-endian for M).
fn path_table(little: bool) -> [u8; 10] {
    let mut t = [0u8; 10];
    t[0] = 1; // identifier length
    t[1] = 0; // extended attribute length
    let lba = if little {
        ROOT_LBA.to_le_bytes()
    } else {
        ROOT_LBA.to_be_bytes()
    };
    t[2..6].copy_from_slice(&lba);
    let parent = if little { 1u16.to_le_bytes() } else { 1u16.to_be_bytes() };
    t[6..8].copy_from_slice(&parent);
    t[8] = 0; // identifier (root)
    t[9] = 0; // pad
    t
}

fn padded(field: &mut [u8], text: &str) {
    let bytes = text.as_bytes();
    let n = bytes.len().min(field.len());
    field[..n].copy_from_slice(&bytes[..n]);
    for b in &mut field[n..] {
        *b = b' ';
    }
}

fn primary_volume_descriptor(volume_id: &str, total_sectors: u32) -> Vec<u8> {
    let mut d = vec![0u8; SECTOR];
    d[0] = 1;
    d[1..6].copy_from_slice(b"CD001");
    d[6] = 1;
    padded(&mut d[8..40], "LINUX");
    padded(&mut d[40..72], volume_id);
    d[80..88].copy_from_slice(&both_u32(total_sectors));
    d[120..124].copy_from_slice(&both_u16(1)); // volume set size
    d[124..128].copy_from_slice(&both_u16(1)); // volume sequence number
    d[128..132].copy_from_slice(&both_u16(SECTOR as u16));
    d[132..140].copy_from_slice(&both_u32(10)); // path table size
    d[140..144].copy_from_slice(&L_TABLE_LBA.to_le_bytes());
    d[148..152].copy_from_slice(&M_TABLE_LBA.to_be_bytes());
    let root = dir_record(ROOT_LBA, SECTOR as u32, true, &[0x00], &[]);
    d[156..156 + root.len()].copy_from_slice(&root);
    padded(&mut d[190..318], ""); // volume set id
    padded(&mut d[318..446], crate::app_upper!()); // publisher
    padded(&mut d[446..574], crate::app_upper!()); // data preparer
    padded(&mut d[574..702], concat!(crate::app_upper!(), " VM SEED")); // application id
    padded(&mut d[702..739], "");
    padded(&mut d[739..776], "");
    padded(&mut d[776..813], "");
    let date = b"2024010100000000";
    for off in [813, 830, 864] {
        d[off..off + 16].copy_from_slice(date);
        d[off + 16] = 0;
    }
    d[847..863].copy_from_slice(b"0000000000000000");
    d[881] = 1; // file structure version
    d
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed() -> Vec<u8> {
        write_iso(
            "cidata",
            &[
                ("user-data", b"#cloud-config\nhostname: vm-x\n"),
                ("meta-data", b"instance-id: vm-1\n"),
            ],
        )
        .unwrap()
    }

    fn u32_le(b: &[u8]) -> u32 {
        u32::from_le_bytes([b[0], b[1], b[2], b[3]])
    }

    #[test]
    fn image_has_a_valid_descriptor_and_rock_ridge_root() {
        let iso = seed();
        assert_eq!(iso.len() % SECTOR, 0);
        let pvd = &iso[16 * SECTOR..17 * SECTOR];
        assert_eq!(pvd[0], 1);
        assert_eq!(&pvd[1..6], b"CD001");
        assert_eq!(std::str::from_utf8(&pvd[40..72]).unwrap().trim_end(), "cidata");
        assert_eq!(u32_le(&pvd[80..84]) as usize * SECTOR, iso.len());
        assert_eq!(u32_le(&pvd[128..130].iter().chain(&[0u8, 0]).copied().collect::<Vec<_>>()), 2048);
        // Root record in the PVD points at the root directory sector.
        assert_eq!(u32_le(&pvd[158..162]), ROOT_LBA);
        // Terminator.
        assert_eq!(iso[17 * SECTOR], 255);
        assert_eq!(&iso[17 * SECTOR + 1..17 * SECTOR + 6], b"CD001");

        // Walk the root directory: `.`, `..`, then the two files with NM names
        // pointing at extents whose bytes are the file contents.
        let root = &iso[20 * SECTOR..21 * SECTOR];
        let mut off = 0;
        let mut records = Vec::new();
        while off < SECTOR && root[off] != 0 {
            let len = root[off] as usize;
            records.push(&root[off..off + len]);
            off += len;
        }
        assert_eq!(records.len(), 4);
        // `.` carries SP (the Rock Ridge marker).
        let dot = records[0];
        assert_eq!(dot[32], 1);
        assert_eq!(dot[33], 0);
        let su = &dot[34..];
        assert_eq!(&su[0..2], b"SP");
        assert_eq!(&su[4..6], &[0xBE, 0xEF]);
        let mut names = Vec::new();
        for rec in &records[2..] {
            let ident_len = rec[32] as usize;
            let mut su_off = 33 + ident_len + usize::from(ident_len.is_multiple_of(2));
            let mut nm = None;
            while su_off + 4 <= rec.len() {
                let sig = &rec[su_off..su_off + 2];
                let len = rec[su_off + 2] as usize;
                if len == 0 {
                    break;
                }
                if sig == b"NM" {
                    nm = Some(String::from_utf8_lossy(&rec[su_off + 5..su_off + len]).to_string());
                }
                su_off += len;
            }
            let lba = u32_le(&rec[2..6]) as usize;
            let size = u32_le(&rec[10..14]) as usize;
            names.push((nm.expect("NM entry"), iso[lba * SECTOR..lba * SECTOR + size].to_vec()));
        }
        assert_eq!(names[0].0, "user-data");
        assert_eq!(names[0].1, b"#cloud-config\nhostname: vm-x\n");
        assert_eq!(names[1].0, "meta-data");
        assert_eq!(names[1].1, b"instance-id: vm-1\n");
    }

    #[test]
    fn rejects_unusable_inputs() {
        assert!(write_iso("cidata", &[("", b"x")]).is_err());
        let many: Vec<(String, Vec<u8>)> = (0..80).map(|i| (format!("f{i}"), vec![1u8])).collect();
        let refs: Vec<(&str, &[u8])> = many.iter().map(|(n, d)| (n.as_str(), d.as_slice())).collect();
        assert!(write_iso("cidata", &refs).is_err(), "one root sector cannot hold 80 records");
    }

    /// Cross-check with the reference reader when it is installed (cdrkit's
    /// `isoinfo`): the Rock Ridge names and the file bytes must read back.
    #[test]
    fn isoinfo_reads_the_rock_ridge_names_and_contents() {
        if crate::paths::resolve_executable("isoinfo").is_none() {
            eprintln!("isoinfo not installed; skipping the reference cross-check");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("seed.iso");
        std::fs::write(&path, seed()).unwrap();
        let list = std::process::Command::new("isoinfo")
            .args(["-R", "-l", "-i"])
            .arg(&path)
            .output()
            .unwrap();
        assert!(list.status.success(), "{}", String::from_utf8_lossy(&list.stderr));
        let listing = String::from_utf8_lossy(&list.stdout);
        assert!(listing.contains("user-data"), "{listing}");
        assert!(listing.contains("meta-data"), "{listing}");
        let extract = std::process::Command::new("isoinfo")
            .args(["-R", "-x", "/user-data", "-i"])
            .arg(&path)
            .output()
            .unwrap();
        assert!(extract.status.success());
        assert_eq!(extract.stdout, b"#cloud-config\nhostname: vm-x\n");
        let label = std::process::Command::new("isoinfo")
            .args(["-d", "-i"])
            .arg(&path)
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&label.stdout).contains("Volume id: cidata"));
    }
}
