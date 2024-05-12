import * as vscode from 'vscode';
import { LRUCache } from 'lru-cache';

export type QCHInfo = {
	path: string;
	anchor: string | undefined;
};


function defaultQCHPaths(): string[]
{
    if (process.platform === 'linux') {
        return [
            '/usr/share/doc/qt5',
            '/usr/share/doc/qt6'
        ];
    } else if (process.platform === 'win32') {
        // TODO: How can we find or detect some reasonable defaults on Windows?
    } else if (process.platform === 'darwin') {
        // TODO: How can we find or detect some reasonalbe defaults on macOS?
    }

    return [];
}

export class QCHDatabase {
	constructor() {
	}

	async scanQCHFiles(): Promise<void>
	{
		const paths = vscode.workspace.getConfiguration('qch').get<string[]>('paths') || defaultQCHPaths();
        this._qchFiles = [];
		for (const path of paths) {
			const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(path));
            for (const [name, type] of entries) {
                if (type === vscode.FileType.File && name.endsWith('.qch')) {
                    this._qchFiles.push(`${path}/${name}`);
                }
            }
        }

        console.debug("Discovered QCH files: ", this._qchFiles);
	}

	async findQCHSymbol(symbol: string): Promise<QCHInfo | undefined>
	{
		return undefined;
	}

	private async loadQCHFile(path: string): Promise<Uint8Array | undefined>
	{
		let data = this.lru.get(path);
		if (!data) {
			data = await vscode.workspace.fs.readFile(vscode.Uri.file(path));
			this.lru.set(path, data, { size: data.byteLength });
		}

		return data;
	}

	private lru = new LRUCache<string, Uint8Array>({
		maxSize: 40 * 1024, 		/* 40 MB */
		maxEntrySize: 15 * 1024 	/* 15 MB */
	});

    private _qchFiles: string[] = [];
}