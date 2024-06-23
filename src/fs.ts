import {
	ConsoleStdout, Directory, PreopenDirectory,
	OpenFile, File as WASIFile, Path,
	WASI, wasi,
} from "@guregu/browser_wasi_shim";
import { wasiError } from "./c";

export class FS {
	os;
	wasi;

	constructor(wasi: WASI, os: OS) {
		this.wasi = wasi;
		this.os = os;
	}

	readDir(name: string): Array<any> {
		const { path } = Path.from(fixPath(name));
		if (!path)
			throw new Error("directory not found: " + name);
		const { ret, entry } = this.os.root.dir.get_entry_for_path(path);
		if (ret !== 0)
			throw wasiError(ret, name);
		if (!(entry instanceof Directory))
			throw new Error(`not a directory: ${name}`);
		return Array.from(entry.contents.keys()).sort();
	}

	createDir(path: string) {
		path = fixPath(path);
		const { ret } = this.os.root.dir.create_entry_for_path(path, true);
		if (ret !== 0) {
			throw wasiError(ret, path);
		}
	}

	removeDir(path: string) {
		path = fixPath(path);
		const ret = this.os.root.path_remove_directory(path);
		if (ret !== 0) {
			throw wasiError(ret, path);
		}
	}

	removeFile(name: string) {
		name = fixPath(name);
		const { path } = Path.from(name);
		if (path === null) {
			throw new Error(`invalid path? ${name}`); // TODO
		}
		const { ret, parent_entry, filename } = this.os.root.dir.get_parent_dir_and_entry_for_path(path, false);
		if (ret !== 0) {
			throw wasiError(ret, name);
		}
		const parent = parent_entry ?? this.os.root.dir;
		parent.contents.delete(filename ?? name);
	}

	rename(path: string, to: string) {
		path = fixPath(path);
		to = fixPath(to);
		const fd = this.wasi.fds.indexOf(this.os.root);
		const ret = this.os.root.path_rename(path, fd, to);
		if (ret !== 0) {
			throw wasiError(ret, `rename(${path}, ${to})`);
		}
	}

	metadata(path: string) {
		path = fixPath(path);
		const { ret, filestat } = this.os.root.path_filestat_get(0, path);
		if (ret !== 0) {
			throw wasiError(ret, path);
		}
		return filestat;
	}

	open(path: string, options: Partial<OpenMode> = {create: false, write: false}) {
		path = fixPath(path);
		// if (options.create) {
		// 	const { ret, entry } = this.os.root.dir.create_entry_for_path(path, false);
		// 	if (ret !== 0) throw wasiError(ret, path);
		// 	return new File(entry as WASIFile); // TODO
		// }
		const rights = BigInt(options.write ? wasi.RIGHTS_FD_WRITE : 0 );
		let oflags = (options.create ? wasi.OFLAGS_CREAT : 0) | 
					(options.truncate ? wasi.OFLAGS_TRUNC : 0);
		let fdflags = (options.append ? wasi.FDFLAGS_APPEND : 0);
		const { ret, fd_obj } = this.os.root.path_open(0, path, oflags, rights, rights, fdflags);
		if (ret !== 0) throw wasiError(ret);
		// TODO
		return new File((fd_obj as OpenFile));
	}
}

export type OpenMode = {
	create: boolean;
	write: boolean;
	append: boolean;
	truncate: boolean;
}

function fixPath(path: string): string {
	if (!path)
		return "";
	if (path[0] === "/")
		return path.slice(1);
	return path;
}

export class File {
	openfile?: OpenFile;
	entity: WASIFile;

	constructor(f: WASIFile | OpenFile) {
		if (f instanceof OpenFile) {
			this.openfile = f;
			this.entity = this.openfile.file;
		} else if (f instanceof WASIFile) {
			this.entity = f;
		} else {
			throw new Error(`not a file: ${f}`);
		}
	}

	lastAccessed():	bigint 	{ return this.entity.stat().atim; }
	lastModified():	bigint 	{ return this.entity.stat().mtim; }
	createdTime():	bigint 	{ return this.entity.stat().ctim; }
	size():			bigint	{ return this.entity.stat().size; }

	read(into?: Uint8Array): Uint8Array {
		if (this.openfile) {
			const size = into instanceof Uint8Array ? into.byteLength
						: this.openfile.file.data.byteLength - Number(this.openfile.file_pos);
			const { ret, data } = this.openfile.fd_read(size);
			if (ret !== 0)
				throw wasiError(ret, `file read error`);

			if (into) {
				into.set(data)
				return into;
			}
			return data;
		}

		return this.entity.data;
	}
	readString(): string {
		const buf = this.read();
		return new TextDecoder().decode(buf);
	}
	write(buf: Uint8Array): number {
		if (this.entity.readonly)
			throw wasiError(wasi.ERRNO_PERM, "write on readonly file");
		this.entity.data = buf;
		return buf.byteLength;
	}
	writeString(buf: string): number {
		this.entity.data = new TextEncoder().encode(buf);
		return this.entity.data.byteLength;
	}
	flush(): void {
		if (this.openfile) {
			const ret = this.openfile.fd_sync();
			if (ret !== 0) throw wasiError(ret, `file sync`);
		}
	}
	seek(position: bigint): bigint {
		if (this.openfile) {
			const { ret, offset } = this.openfile.fd_seek(position, wasi.WHENCE_SET);
			if (ret !== 0) throw wasiError(ret, `file seek`);
			return offset;
		}
		return BigInt(0);
	}
}

export type OS = {
	stdout: OutputStream;
	stderr: OutputStream;
	//oob: 	OutputStream;
	// tmp: 	PreopenDirectory;
	root: 	PreopenDirectory;
}

export function newOS(): OS {
	return {
		stdout: new OutputStream(),
		stderr: new OutputStream(),
		//oob: 	new OutputStream(),
		// tmp: 	new PreopenDirectory("/tmp", new Map()),
		root: 	new PreopenDirectory(".", new Map()),
	};
}

class OutputStream {
	bufs: Uint8Array[] = [];
	fd: ConsoleStdout;
	constructor() {
		this.fd = new ConsoleStdout((buf) => {
			if (buf.length > 0)
				this.bufs.push(buf);
		});
	}
	join(): Uint8Array {
		return joinBuffers(this.bufs);
	}
	reset(): void {
		// TODO: re-use buffers?
		this.bufs = [];
	}
}


function joinBuffers(bufs: Uint8Array[]) {
	if (bufs.length === 0) {
		return new Uint8Array(0);
	}
	if (bufs.length === 1) {
		return bufs[0];
	}
	let size = 0;
	for (const buf of bufs) {
		size += buf.length;
	}
	const ret = new Uint8Array(size);
	let i = 0;
	for (const buf of bufs) {
		ret.set(buf, i);
		i += buf.length;
	}
	return ret;
}
