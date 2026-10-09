//! Windows counterpart of the Unix `ProjectDir`: no path-based child I/O.
//! `NtCreateFile` resolves exactly one name relative to a held directory,
//! opening the reparse point itself; handle metadata then rejects every
//! reparse type, including junctions. A renamed parent cannot redirect the
//! rest of a read or listing. Unsupported native operations fail closed.
//!
//! The phone's drop boxes also create folders and files and delete files
//! through the same handles: `FILE_CREATE` never opens an existing name (nor a
//! reparse point standing there), and a delete marks the one handle-relative
//! name it opened, reparse point included, never a link's target.
//!
//! A root agent's mail `attach` (`services::mail_attach`) reads through the
//! same walk ([`ProjectDir::open_root`], [`ProjectDir::lookup_dir`],
//! [`ProjectDir::lookup_file`]), hence the crate-wide visibility.

use std::{
    fs,
    mem::{offset_of, size_of},
    os::windows::{
        fs::{MetadataExt, OpenOptionsExt},
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
            ERROR_NO_MORE_FILES, HANDLE, NTSTATUS, OBJ_CASE_INSENSITIVE, STATUS_OBJECT_NAME_COLLISION,
            STATUS_OBJECT_NAME_NOT_FOUND, STATUS_OBJECT_PATH_NOT_FOUND, UNICODE_STRING,
        },
        Storage::FileSystem::{
            FileDispositionInfo, FileIdBothDirectoryInfo, FileIdBothDirectoryRestartInfo,
            GetFileInformationByHandleEx, SetFileInformationByHandle, DELETE, FILE_ACCESS_RIGHTS,
            FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
            FILE_DISPOSITION_INFO, FILE_FLAGS_AND_ATTRIBUTES, FILE_FLAG_BACKUP_SEMANTICS,
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_WRITE, FILE_ID_BOTH_DIR_INFO,
            FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_DELETE,
            FILE_SHARE_READ, FILE_SHARE_WRITE, SYNCHRONIZE,
        },
        System::IO::IO_STATUS_BLOCK,
    },
};

use super::{canonical_root, plain_segment, valid_rel, FilesError};

pub(crate) struct ProjectDir(fs::File);

impl ProjectDir {
    pub(super) fn open(root: &Path, rel: &str) -> Result<Self, FilesError> {
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
        // Only the configured root is opened by path. Reparse points in its
        // project-controlled leaf are refused, including a replacement after
        // canonicalization. Every operation below it starts from this handle.
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags((FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT).0)
            .open(root)
            .map_err(|_| FilesError::Unavailable)?;
        plain_metadata(&file)
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

    /// The folder `name` in this one: `Ok(None)` when nothing has that name,
    /// `Err(())` when something does but is not a plain folder (a reparse
    /// point, a file) — never traversed either way.
    pub(crate) fn lookup_dir(&self, name: &str) -> Result<Option<Self>, ()> {
        match self.nt_create(
            name,
            FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_OPEN,
            FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT,
            Default::default(),
        ) {
            Ok(file) if plain_metadata(&file).is_some_and(|meta| meta.is_dir()) => Ok(Some(Self(file))),
            Ok(_) => Err(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(()),
        }
    }

    /// The regular file `name` in this one, opened for reading, with its
    /// metadata: `Ok(None)` when nothing has that name, `Err(())` when
    /// something does but is not a plain file (a reparse point, a folder) —
    /// never followed either way.
    pub(crate) fn lookup_file(&self, name: &str) -> Result<Option<(fs::File, fs::Metadata)>, ()> {
        match self.nt_create(
            name,
            FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_OPEN,
            FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT,
            Default::default(),
        ) {
            Ok(file) => match plain_metadata(&file) {
                Some(meta) if meta.is_file() => Ok(Some((file, meta))),
                _ => Err(()),
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(()),
        }
    }

    /// Creates the folder `name` here unless something already has that name.
    /// Open it with [`Self::lookup_dir`], which refuses a reparse point there.
    pub(in crate::services::mobile_control) fn create_dir(&self, name: &str) -> std::io::Result<()> {
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
    pub(in crate::services::mobile_control) fn create_file(&self, name: &str) -> std::io::Result<fs::File> {
        self.nt_create(name, FILE_GENERIC_WRITE, FILE_CREATE, FILE_NON_DIRECTORY_FILE, FILE_ATTRIBUTE_NORMAL)
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

    pub(super) fn child_dir(&self, name: &str) -> Option<Self> {
        self.lookup_dir(name).ok().flatten()
    }

    pub(super) fn child_dir_meta(&self, name: &str) -> Option<fs::Metadata> {
        plain_metadata(&self.child_dir(name)?.0)
    }

    pub(in crate::services::mobile_control) fn open_file(&self, name: &str) -> Option<(fs::File, fs::Metadata)> {
        self.lookup_file(name).ok().flatten()
    }

    pub(in crate::services::mobile_control) fn entries(&self) -> Result<Vec<(String, bool)>, FilesError> {
        // u64 storage aligns the native records; 64 KiB fits even the longest
        // filesystem name. Enumeration uses this directory handle, never its
        // former path, and a fresh enumeration starts at the first entry.
        let mut buffer = vec![0u64; 8192];
        let bytes = buffer.len() * size_of::<u64>();
        let name_offset = offset_of!(FILE_ID_BOTH_DIR_INFO, FileName);
        let mut restart = true;
        let mut entries = Vec::new();
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
                    return Ok(entries);
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
                if record.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 == 0 {
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
                        if plain_segment(&name) {
                            entries.push((
                                name,
                                record.FileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0,
                            ));
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
    } else {
        std::io::Error::other(format!("NTSTATUS {:#010x}", status.0))
    }
}

fn plain_metadata(file: &fs::File) -> Option<fs::Metadata> {
    file.metadata()
        .ok()
        .filter(|meta| meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 == 0)
}
