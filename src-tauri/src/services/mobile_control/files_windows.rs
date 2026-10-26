//! Windows counterpart of the Unix `ProjectDir`: no path-based child I/O.
//! `NtCreateFile` resolves exactly one name relative to a held directory,
//! opening the reparse point itself; its tag then rejects every link-type
//! (name-surrogate) reparse point: symbolic links, junctions/mount points, WSL
//! links. Any other reparse point (OneDrive Files On-Demand placeholders,
//! which tag every file and folder, the project root included; deduplicated
//! or WOF-compressed files) is opened once more by the same name without
//! `FILE_OPEN_REPARSE_POINT`, so its filesystem filter can serve (hydrate)
//! it, and kept only when that second handle is the same file as the first.
//! A renamed parent cannot redirect the rest of a read or listing.
//! Unsupported native operations fail closed.
//!
//! The phone's drop boxes also create folders and files and delete files
//! through the same handles: `FILE_CREATE` never opens an existing name (nor a
//! reparse point standing there), and a delete marks the one handle-relative
//! name it opened, reparse point included, never a link's target. The
//! phone's uploads into a browsed folder (`uploads.rs`) do the same from
//! [`ProjectDir::open`].
//!
//! A root agent's mail `attach` (`services::mail_attach`) reads through the
//! same walk ([`ProjectDir::open_root`], [`ProjectDir::lookup_dir`],
//! [`ProjectDir::lookup_file`]), and the viewers' absolute-path reads and
//! saves (`services::fs_confine::open_confined`) and mail's "Save to project"
//! (`commands::mail`) read, write and create through it, hence the
//! crate-wide visibility.

use std::{
    fs,
    mem::{offset_of, size_of},
    ops::ControlFlow,
    os::windows::{
        fs::OpenOptionsExt,
        io::{AsRawHandle, FromRawHandle},
    },
    path::Path,
};

use ::windows::{
    core::{HRESULT, PWSTR},
    Wdk::{
        Foundation::OBJECT_ATTRIBUTES,
        Storage::FileSystem::{
            NtCreateFile, FILE_CREATE, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN,
            FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT, NTCREATEFILE_CREATE_DISPOSITION,
            NTCREATEFILE_CREATE_OPTIONS,
        },
    },
    Win32::{
        Foundation::{
            ERROR_NO_MORE_FILES, HANDLE, NTSTATUS, OBJ_CASE_INSENSITIVE, STATUS_FILE_IS_A_DIRECTORY,
            STATUS_OBJECT_NAME_COLLISION, STATUS_OBJECT_NAME_NOT_FOUND, STATUS_OBJECT_PATH_NOT_FOUND,
            UNICODE_STRING,
        },
        Storage::FileSystem::{
            FileAttributeTagInfo, FileDispositionInfo, FileIdBothDirectoryInfo,
            FileIdBothDirectoryRestartInfo, FileIdInfo, GetFileInformationByHandleEx,
            SetFileInformationByHandle, DELETE, FILE_ACCESS_RIGHTS, FILE_ATTRIBUTE_DIRECTORY,
            FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO,
            FILE_DISPOSITION_INFO, FILE_FLAGS_AND_ATTRIBUTES, FILE_FLAG_BACKUP_SEMANTICS,
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_WRITE, FILE_ID_BOTH_DIR_INFO, FILE_ID_INFO,
            FILE_INFO_BY_HANDLE_CLASS,
            FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_DELETE,
            FILE_SHARE_READ, FILE_SHARE_WRITE, SYNCHRONIZE,
        },
        System::IO::IO_STATUS_BLOCK,
    },
};

use super::{canonical_root, plain_segment, valid_rel, FilesError, WriteRefusal};

pub(crate) struct ProjectDir(fs::File);

impl ProjectDir {
    pub(in crate::services::mobile_control) fn open(root: &Path, rel: &str) -> Result<Self, FilesError> {
        let mut dir = Self::open_root(root)?;
        if !valid_rel(rel) {
            return Err(FilesError::NotFound);
        }
        if !rel.is_empty() {
            for name in rel.split('/') {
                dir = dir.child_dir(name).ok_or(FilesError::NotFound)?;
            }
        }
        Ok(dir)
    }

    /// The project root itself, held open — the one folder opened by path.
    pub(crate) fn open_root(root: &Path) -> Result<Self, FilesError> {
        let root = canonical_root(root)?;
        // Only the configured root is opened by path. A link in its
        // project-controlled leaf is refused, including a replacement after
        // canonicalization; a OneDrive placeholder folder is opened through
        // its filter (see the module docs). Every operation below it starts
        // from this handle.
        let open = |flags: FILE_FLAGS_AND_ATTRIBUTES| {
            fs::OpenOptions::new().read(true).custom_flags(flags.0).open(&root)
        };
        let first = open(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .map_err(|_| FilesError::Unavailable)?;
        let file = unlinked(first, || open(FILE_FLAG_BACKUP_SEMANTICS)).map_err(|_| FilesError::Unavailable)?;
        file.metadata()
            .ok()
            .filter(fs::Metadata::is_dir)
            .ok_or(FilesError::Unavailable)?;
        Ok(Self(file))
    }

    fn handle(&self) -> HANDLE {
        HANDLE(self.0.as_raw_handle())
    }

    /// `NtCreateFile` of exactly one name relative to this folder, always
    /// synchronous; the NTSTATUS a caller tells apart becomes an `io` kind.
    fn nt_create(
        &self,
        name: &str,
        access: FILE_ACCESS_RIGHTS,
        disposition: NTCREATEFILE_CREATE_DISPOSITION,
        options: NTCREATEFILE_CREATE_OPTIONS,
        attributes: FILE_FLAGS_AND_ATTRIBUTES,
    ) -> std::io::Result<fs::File> {
        let invalid = || std::io::Error::from(std::io::ErrorKind::InvalidInput);
        // Do not let a caller turn the single native name into a multi-step
        // path, an absolute/device path, or an alternate data stream.
        if !plain_segment(name) {
            return Err(invalid());
        }
        let mut name: Vec<u16> = name.encode_utf16().collect();
        let length = name
            .len()
            .checked_mul(2)
            .and_then(|bytes| u16::try_from(bytes).ok())
            .ok_or_else(invalid)?;
        let unicode = UNICODE_STRING {
            Length: length,
            MaximumLength: length,
            Buffer: PWSTR(name.as_mut_ptr()),
        };
        let object = OBJECT_ATTRIBUTES {
            Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
            RootDirectory: self.handle(),
            ObjectName: &unicode,
            Attributes: OBJ_CASE_INSENSITIVE,
            ..Default::default()
        };
        let mut handle = HANDLE::default();
        let mut status = IO_STATUS_BLOCK::default();
        // SAFETY: all structures and the UTF-16 buffer remain live during the
        // synchronous call; RootDirectory is our live directory handle. A
        // single component plus OPEN_REPARSE_POINT (or FILE_CREATE, which
        // never opens an existing name) ensures the kernel cannot traverse a
        // substituted junction or link.
        let result = unsafe {
            NtCreateFile(
                &mut handle,
                access,
                &object,
                &mut status,
                None,
                attributes,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                disposition,
                options | FILE_SYNCHRONOUS_IO_NONALERT,
                None,
                0,
            )
        };
        if result.0 < 0 {
            return Err(nt_error(result));
        }
        // SAFETY: the successful open returned a fresh handle owned only here.
        Ok(unsafe { fs::File::from_raw_handle(handle.0) })
    }

    /// The existing `name` here, opened on the reparse point itself first:
    /// a link (name surrogate) is [`Unlinked::Link`] and never followed; any
    /// other reparse point is opened again through its filter, see
    /// [`unlinked`].
    fn open_unlinked(
        &self,
        name: &str,
        access: FILE_ACCESS_RIGHTS,
        options: NTCREATEFILE_CREATE_OPTIONS,
    ) -> Result<fs::File, Unlinked> {
        let first = self
            .nt_create(name, access, FILE_OPEN, options | FILE_OPEN_REPARSE_POINT, Default::default())
            .map_err(Unlinked::Io)?;
        unlinked(first, || self.nt_create(name, access, FILE_OPEN, options, Default::default()))
    }

    /// The folder `name` in this one: `Ok(None)` when nothing has that name,
    /// `Err(())` when something does but is not a plain folder (a link, a
    /// file) — never traversed either way.
    pub(crate) fn lookup_dir(&self, name: &str) -> Result<Option<Self>, ()> {
        match self.open_unlinked(
            name,
            FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_DIRECTORY_FILE,
        ) {
            Ok(file) if file.metadata().is_ok_and(|meta| meta.is_dir()) => Ok(Some(Self(file))),
            Ok(_) | Err(Unlinked::Link) => Err(()),
            Err(Unlinked::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(Unlinked::Io(_)) => Err(()),
        }
    }

    /// The held folder's own handle, for its metadata.
    pub(crate) fn into_file(self) -> fs::File {
        self.0
    }

    /// The regular file `name` in this one, opened for reading, with its
    /// metadata: `Ok(None)` when nothing has that name, `Err(())` when
    /// something does but is not a plain file (a link, a folder) — never
    /// followed either way.
    pub(crate) fn lookup_file(&self, name: &str) -> Result<Option<(fs::File, fs::Metadata)>, ()> {
        match self.open_unlinked(
            name,
            FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_NON_DIRECTORY_FILE,
        ) {
            Ok(file) => match file.metadata() {
                Ok(meta) if meta.is_file() => Ok(Some((file, meta))),
                _ => Err(()),
            },
            Err(Unlinked::Link) => Err(()),
            Err(Unlinked::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(Unlinked::Io(_)) => Err(()),
        }
    }

    /// Creates the folder `name` here unless something already has that name.
    /// Open it with [`Self::lookup_dir`], which refuses a link there.
    pub(crate) fn create_dir(&self, name: &str) -> std::io::Result<()> {
        match self.nt_create(
            name,
            FILE_LIST_DIRECTORY | SYNCHRONIZE,
            FILE_CREATE,
            FILE_DIRECTORY_FILE,
            FILE_ATTRIBUTE_NORMAL,
        ) {
            Ok(_) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            Err(error) => Err(error),
        }
    }

    /// A new regular file `name` here, for writing: never an existing name
    /// (`AlreadyExists`), never through a reparse point.
    pub(crate) fn create_file(&self, name: &str) -> std::io::Result<fs::File> {
        self.nt_create(name, FILE_GENERIC_WRITE, FILE_CREATE, FILE_NON_DIRECTORY_FILE, FILE_ATTRIBUTE_NORMAL)
    }

    /// The existing regular file `name` here, opened for writing and emptied
    /// — an in-place save that keeps the file's identity and ACL. `Ok(None)`
    /// when nothing has that name. The name is first opened on the reparse
    /// point itself (`FILE_OPEN_REPARSE_POINT`) for its **attributes only**:
    /// a cloud filter may refuse a write open of a raw OneDrive placeholder,
    /// but the tag and file id are always readable. A link's tag is refused;
    /// write access is asked only by the second open (see [`reopened`]),
    /// which goes through the filter for a placeholder. The file is truncated
    /// only after its own handle proved it regular.
    pub(crate) fn open_existing_for_write(&self, name: &str) -> Result<Option<fs::File>, WriteRefusal> {
        let options = FILE_NON_DIRECTORY_FILE;
        let io = |error: std::io::Error| match error.kind() {
            std::io::ErrorKind::NotFound => Ok(None),
            std::io::ErrorKind::IsADirectory => Err(WriteRefusal::NotFile),
            _ => Err(WriteRefusal::Io(error)),
        };
        let probe = match self.nt_create(
            name,
            FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_OPEN,
            options | FILE_OPEN_REPARSE_POINT,
            Default::default(),
        ) {
            Ok(probe) => probe,
            Err(error) => return io(error),
        };
        let access = FILE_GENERIC_WRITE | FILE_READ_ATTRIBUTES;
        let file = match reopened(probe, |plain| {
            let options = if plain { options | FILE_OPEN_REPARSE_POINT } else { options };
            self.nt_create(name, access, FILE_OPEN, options, Default::default())
        }) {
            Ok(file) => file,
            Err(Unlinked::Link) => return Err(WriteRefusal::Link),
            Err(Unlinked::Io(error)) => return io(error),
        };
        let meta = file.metadata().map_err(WriteRefusal::Io)?;
        if !meta.is_file() {
            return Err(WriteRefusal::NotFile);
        }
        file.set_len(0).map_err(WriteRefusal::Io)?;
        Ok(Some(file))
    }

    /// Deletes the non-folder `name` here — a reparse point itself, never
    /// its target — through the handle it opened.
    pub(in crate::services::mobile_control) fn remove_file(&self, name: &str) -> std::io::Result<()> {
        let file = self.nt_create(
            name,
            DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_OPEN,
            FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT,
            Default::default(),
        )?;
        let info = FILE_DISPOSITION_INFO { DeleteFile: true };
        // SAFETY: a live handle opened with DELETE access and a properly sized,
        // live disposition record.
        unsafe {
            SetFileInformationByHandle(
                HANDLE(file.as_raw_handle()),
                FileDispositionInfo,
                (&info as *const FILE_DISPOSITION_INFO).cast(),
                size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        }
        .map_err(|error| std::io::Error::other(error.to_string()))
    }

    /// Removes the empty folder `name` here — a reparse point itself, never
    /// its target; a folder with anything in it refuses the disposition.
    pub(in crate::services::mobile_control) fn remove_empty_dir(&self, name: &str) -> std::io::Result<()> {
        let file = self.nt_create(
            name,
            DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_OPEN,
            FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT,
            Default::default(),
        )?;
        let info = FILE_DISPOSITION_INFO { DeleteFile: true };
        // SAFETY: a live handle opened with DELETE access and a properly sized,
        // live disposition record.
        unsafe {
            SetFileInformationByHandle(
                HANDLE(file.as_raw_handle()),
                FileDispositionInfo,
                (&info as *const FILE_DISPOSITION_INFO).cast(),
                size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        }
        .map_err(|error| std::io::Error::other(error.to_string()))
    }

    pub(super) fn child_dir(&self, name: &str) -> Option<Self> {
        self.lookup_dir(name).ok().flatten()
    }

    pub(super) fn child_dir_meta(&self, name: &str) -> Option<fs::Metadata> {
        self.child_dir(name)?.0.metadata().ok()
    }

    pub(in crate::services::mobile_control) fn open_file(&self, name: &str) -> Option<(fs::File, fs::Metadata)> {
        self.lookup_file(name).ok().flatten()
    }

    pub(in crate::services::mobile_control) fn entries(&self) -> Result<Vec<(String, bool)>, FilesError> {
        let mut entries = Vec::new();
        self.each_entry(|name, is_dir| {
            entries.push((name.to_owned(), is_dir));
            ControlFlow::Continue(())
        })?;
        Ok(entries)
    }

    /// [`Self::entries`] one at a time, read only until `visit` breaks — what
    /// a folder's item count stops early on. Links are left out as there;
    /// hidden names are the caller's to drop.
    pub(in crate::services::mobile_control) fn each_entry(
        &self,
        mut visit: impl FnMut(&str, bool) -> ControlFlow<()>,
    ) -> Result<(), FilesError> {
        // u64 storage aligns the native records; 64 KiB fits even the longest
        // filesystem name. Enumeration uses this directory handle, never its
        // former path, and a fresh enumeration starts at the first entry.
        let mut buffer = vec![0u64; 8192];
        let bytes = buffer.len() * size_of::<u64>();
        let name_offset = offset_of!(FILE_ID_BOTH_DIR_INFO, FileName);
        let mut restart = true;
        loop {
            buffer.fill(0);
            let class = if restart {
                FileIdBothDirectoryRestartInfo
            } else {
                FileIdBothDirectoryInfo
            };
            // SAFETY: a live directory handle and a suitably aligned writable
            // allocation, with its exact byte length.
            let result = unsafe {
                GetFileInformationByHandleEx(
                    self.handle(),
                    class,
                    buffer.as_mut_ptr().cast(),
                    bytes as u32,
                )
            };
            if let Err(error) = result {
                if error.code() == HRESULT::from_win32(ERROR_NO_MORE_FILES.0) {
                    return Ok(());
                }
                return Err(FilesError::Io(error.to_string()));
            }
            restart = false;
            let mut offset = 0usize;
            loop {
                let invalid = || FilesError::Io("Invalid directory record".to_owned());
                if offset > bytes - size_of::<FILE_ID_BOTH_DIR_INFO>() {
                    return Err(invalid());
                }
                // SAFETY: bounds checked above; unaligned reading also handles
                // any unusual native record packing without forming a reference.
                let record = unsafe {
                    buffer
                        .as_ptr()
                        .cast::<u8>()
                        .add(offset)
                        .cast::<FILE_ID_BOTH_DIR_INFO>()
                        .read_unaligned()
                };
                let length = record.FileNameLength as usize;
                let end = offset
                    .checked_add(name_offset)
                    .and_then(|v| v.checked_add(length))
                    .ok_or_else(invalid)?;
                if !length.is_multiple_of(2) || end > bytes || !offset.is_multiple_of(2) {
                    return Err(invalid());
                }
                // For a reparse point, `EaSize` holds its tag (MS-FSCC
                // 2.4.17): links are left out, placeholders listed.
                if record.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 == 0
                    || !is_name_surrogate(record.EaSize)
                {
                    // SAFETY: the UTF-16 slice lies within the allocation and
                    // starts at a u16-aligned offset, checked above.
                    let name = unsafe {
                        std::slice::from_raw_parts(
                            buffer
                                .as_ptr()
                                .cast::<u8>()
                                .add(offset + name_offset)
                                .cast::<u16>(),
                            length / 2,
                        )
                    };
                    if let Ok(name) = String::from_utf16(name) {
                        // Hidden names are the caller's to drop (the file
                        // browser does); a drop box lists under `.tabtivity`.
                        if plain_segment(&name)
                            && visit(&name, record.FileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0)
                                .is_break()
                        {
                            return Ok(());
                        }
                    }
                }
                if record.NextEntryOffset == 0 {
                    break;
                }
                let next = offset
                    .checked_add(record.NextEntryOffset as usize)
                    .ok_or_else(invalid)?;
                if next < end {
                    return Err(invalid());
                }
                offset = next;
            }
        }
    }
}

/// The NTSTATUS values a caller tells apart, as `io` kinds.
fn nt_error(status: NTSTATUS) -> std::io::Error {
    if status == STATUS_OBJECT_NAME_NOT_FOUND || status == STATUS_OBJECT_PATH_NOT_FOUND {
        std::io::ErrorKind::NotFound.into()
    } else if status == STATUS_OBJECT_NAME_COLLISION {
        std::io::ErrorKind::AlreadyExists.into()
    } else if status == STATUS_FILE_IS_A_DIRECTORY {
        std::io::ErrorKind::IsADirectory.into()
    } else {
        std::io::Error::other(format!("NTSTATUS {:#010x}", status.0))
    }
}

/// `IsReparseTagNameSurrogate`: the tag makes the entry stand for another
/// named file or folder — a symbolic link, a junction or mount point, a WSL
/// link. These are the links decision D1 refuses; every other tag (cloud
/// placeholders, dedup, WOF compression) marks a file that is itself here.
pub(super) fn is_name_surrogate(tag: u32) -> bool {
    tag & 0x2000_0000 != 0
}

/// Why [`unlinked`] gave no handle.
#[derive(Debug)]
pub(super) enum Unlinked {
    /// A link (name surrogate), or a name that led to another file when
    /// opened again.
    Link,
    Io(std::io::Error),
}

/// Something a handle can be asked about by `GetFileInformationByHandleEx`.
fn by_handle<T: Default>(file: &fs::File, class: FILE_INFO_BY_HANDLE_CLASS) -> std::io::Result<T> {
    let mut info = T::default();
    // SAFETY: a live handle and a writable, properly sized record of the
    // type the class fills (callers pair them).
    unsafe {
        GetFileInformationByHandleEx(
            HANDLE(file.as_raw_handle()),
            class,
            (&mut info as *mut T).cast(),
            size_of::<T>() as u32,
        )
    }
    .map_err(|error| std::io::Error::other(error.to_string()))?;
    Ok(info)
}

/// The volume and file id of a handle: the same pair is the same file.
pub(super) fn identity(file: &fs::File) -> std::io::Result<(u64, [u8; 16])> {
    let info: FILE_ID_INFO = by_handle(file, FileIdInfo)?;
    Ok((info.VolumeSerialNumber, info.FileId.Identifier))
}

/// [`identity`] of what `path` names, a link followed: opened for its
/// attributes only, with backup semantics so a folder opens too.
pub(super) fn path_identity(path: &Path) -> std::io::Result<(u64, [u8; 16])> {
    const FILE_READ_ATTRIBUTES: u32 = 0x80;
    const SHARE_ALL: u32 = 0x7;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    let file = fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(SHARE_ALL)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)?;
    identity(&file)
}

/// Like [`unlinked`], for a `first` handle opened on the name itself with
/// attribute access only: the handle kept is always a second open,
/// `reopen(plain)`. `plain` (no reparse point): opened on the name itself
/// again, so a link swapped in meanwhile is opened as the link, never
/// followed; any other non-link reparse point: through its filter. Either
/// way the second handle is kept only when it is the same file as `first`.
pub(super) fn reopened(
    first: fs::File,
    reopen: impl FnOnce(bool) -> std::io::Result<fs::File>,
) -> Result<fs::File, Unlinked> {
    let tag: FILE_ATTRIBUTE_TAG_INFO = by_handle(&first, FileAttributeTagInfo).map_err(Unlinked::Io)?;
    let plain = tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 == 0;
    if !plain && is_name_surrogate(tag.ReparseTag) {
        return Err(Unlinked::Link);
    }
    let again = reopen(plain).map_err(Unlinked::Io)?;
    if identity(&first).map_err(Unlinked::Io)? == identity(&again).map_err(Unlinked::Io)? {
        Ok(again)
    } else {
        Err(Unlinked::Link)
    }
}

/// `first` was opened on the name itself (`FILE_OPEN_REPARSE_POINT`). A
/// plain file or folder is returned as it is; a link (name surrogate) is
/// refused. Any other reparse point is opened again by `reopen`, without
/// that flag, so its filter serves it (a OneDrive placeholder hydrates
/// instead of reading as empty or failing), and that handle is kept only
/// when it is the same file as `first`: a link swapped in between the two
/// opens leads to another file and is refused, as is a filter that
/// redirects to one.
pub(super) fn unlinked(
    first: fs::File,
    reopen: impl FnOnce() -> std::io::Result<fs::File>,
) -> Result<fs::File, Unlinked> {
    let tag: FILE_ATTRIBUTE_TAG_INFO = by_handle(&first, FileAttributeTagInfo).map_err(Unlinked::Io)?;
    if tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 == 0 {
        return Ok(first);
    }
    if is_name_surrogate(tag.ReparseTag) {
        return Err(Unlinked::Link);
    }
    let again = reopen().map_err(Unlinked::Io)?;
    if identity(&first).map_err(Unlinked::Io)? == identity(&again).map_err(Unlinked::Io)? {
        Ok(again)
    } else {
        Err(Unlinked::Link)
    }
}
