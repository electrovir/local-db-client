// cspell:word keyvaluepairs

import {assert} from '@augment-vir/assert';
import {getObjectTypedEntries, randomString, type AnyObject} from '@augment-vir/common';
import {describe, it} from '@augment-vir/test';
import {Store} from 'indexed-vir';
import {migrateLegacyLocalForageStore} from './migrate-local-forage.js';

const legacyObjectStoreName = 'keyvaluepairs';

/**
 * Seeds a database with a legacy LocalForage-style object store (`keyvaluepairs`), created at
 * database version 1 to match how earlier versions of this package stored their data.
 */
function seedLegacyLocalForageStore(databaseName: string, entries: Readonly<AnyObject>) {
    return new Promise<void>((resolve, reject) => {
        const openRequest = indexedDB.open(databaseName, 1);
        openRequest.onupgradeneeded = () => {
            openRequest.result.createObjectStore(legacyObjectStoreName);
        };
        openRequest.onerror = () =>
            reject(openRequest.error || new Error(`Failed to open database '${databaseName}'.`));
        openRequest.onsuccess = () => {
            const database = openRequest.result;
            const objectStore = database
                .transaction(legacyObjectStoreName, 'readwrite')
                .objectStore(legacyObjectStoreName);
            getObjectTypedEntries(entries).forEach(
                ([
                    key,
                    value,
                ]) => objectStore.put(value, String(key)),
            );
            objectStore.transaction.oncomplete = () => {
                database.close();
                resolve();
            };
            objectStore.transaction.onerror = () => {
                database.close();
                reject(
                    objectStore.transaction.error ||
                        new Error(`Failed to seed legacy store in database '${databaseName}'.`),
                );
            };
        };
    });
}

/** Opens the database (without forcing an upgrade) and returns the names of its object stores. */
function readObjectStoreNames(databaseName: string) {
    return new Promise<string[]>((resolve, reject) => {
        const openRequest = indexedDB.open(databaseName);
        openRequest.onerror = () =>
            reject(openRequest.error || new Error(`Failed to open database '${databaseName}'.`));
        openRequest.onsuccess = () => {
            const database = openRequest.result;
            const names = Array.from(database.objectStoreNames);
            database.close();
            resolve(names);
        };
    });
}

/** Reads every entry currently stored in the given indexed-vir store into a plain object. */
async function readAllStoreValues(store: Readonly<Store>) {
    const values: AnyObject = {};
    await store.iterate((value, key) => {
        values[key] = value;
    });
    return values;
}

function createDatabaseName() {
    return `migrate-test-${randomString(32)}`;
}

describe(migrateLegacyLocalForageStore.name, () => {
    it('migrates all legacy values into the given store', async () => {
        const databaseName = createDatabaseName();
        const legacyData = {
            stringValue: 'some text',
            numberValue: 42,
            booleanValue: true,
            objectValue: {
                name: 'a',
                age: 1,
            },
            arrayValue: [
                'x',
                'y',
            ],
        };
        await seedLegacyLocalForageStore(databaseName, legacyData);

        const store = new Store(databaseName);
        await migrateLegacyLocalForageStore(databaseName, store);

        assert.deepEquals(await readAllStoreValues(store), legacyData);
    });

    it('removes the legacy object store and replaces it with the indexed-vir store', async () => {
        const databaseName = createDatabaseName();
        await seedLegacyLocalForageStore(databaseName, {
            stringValue: 'value',
        });

        const store = new Store(databaseName);
        await migrateLegacyLocalForageStore(databaseName, store);

        assert.deepEquals(await readObjectStoreNames(databaseName), [store.objectStoreName]);
    });

    it('deletes an empty legacy store and leaves a usable indexed-vir store', async () => {
        const databaseName = createDatabaseName();
        await seedLegacyLocalForageStore(databaseName, {});

        const store = new Store(databaseName);
        await migrateLegacyLocalForageStore(databaseName, store);

        assert.strictEquals(await store.size(), 0);

        await store.setItem('afterMigration', 'works');
        assert.strictEquals(await store.getItem('afterMigration'), 'works');
        assert.isFalse((await readObjectStoreNames(databaseName)).includes(legacyObjectStoreName));
    });

    it('is a no-op when no legacy store exists', async () => {
        const databaseName = createDatabaseName();

        const store = new Store(databaseName);
        await migrateLegacyLocalForageStore(databaseName, store);

        assert.strictEquals(await store.size(), 0);

        await store.setItem('key', 'value');
        assert.strictEquals(await store.getItem('key'), 'value');
    });

    it('leaves an already-migrated indexed-vir store untouched', async () => {
        const databaseName = createDatabaseName();

        const store = new Store(databaseName);
        await store.setItem('existing', 'previously migrated');

        await migrateLegacyLocalForageStore(databaseName, store);

        assert.deepEquals(await readAllStoreValues(store), {
            existing: 'previously migrated',
        });
    });
});
