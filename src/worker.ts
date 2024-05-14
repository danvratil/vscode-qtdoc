import { parentPort } from 'worker_threads';
import { Indexer } from './indexer';

type Message = {
    type: 'checkIndex',
    qchDirectories: string[]
} | {
    type: 'reindex'
    qchFiles: string[]
};

export type Response = {
    type: 'progress';
    progress: {
        done: number;
        total: number;
    }
} | {
    type: 'checkIndexDone'
    filesToReindex: string[];
} | {
    type: 'indexingDone'
} | {
    type: 'error';
    error: string;
};

parentPort!.addListener('message', async (message: Message) => {
    if (message.type === 'checkIndex') {
        const indexer = new Indexer();
        indexer.onProgress = (done: number, total: number) => {
            parentPort!.postMessage({ type: 'progress', progress: { done: done, total: total } });
        };
        try {
            const result = await indexer.checkIndex(message.qchDirectories);
            parentPort!.postMessage({ type: 'checkIndexDone', filesToReindex: result.filesToReindex });
        } catch (e) {
            parentPort!.postMessage({ type: 'error', error: (e as Error).message });
            return;
        }
    } else if (message.type === 'reindex') {
        const indexer = new Indexer();
        indexer.onProgress = (done: number, total: number) => {
            parentPort!.postMessage({ type: 'progress', progress: { done: done, total: total } });
        };
        try {
            await indexer.index(message.qchFiles);
            parentPort!.postMessage({ type: 'indexingDone' });
        } catch (e) {
            parentPort!.postMessage({ type: 'error', error: (e as Error).message });
            return;
        }
    }
});
