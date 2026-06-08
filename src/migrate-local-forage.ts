// cspell:word keyvaluepairs

import {getObjectTypedEntries, stringify, type AnyObject} from '@augment-vir/common';
import {type Store} from 'indexed-vir';

/**
 * The object store name that earlier, LocalForage-backed versions of this package used to store
 * data. LocalForage's `createInstance({name})` places all values in this default object store
 * inside the database named after `name`.
 */
const legacyObjectStoreName = 'keyvaluepairs';

function deleteDatabase(databaseName: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(databaseName);
        request.onsuccess = () => resolve();
        request.onerror = () =>
            reject(request.error || new Error(`Failed to delete database '${databaseName}'.`));
    });
}

/**
 * Reads all values out of the legacy LocalForage object store (if present) and then deletes the
 * entire database so that indexed-vir can recreate it cleanly.
 *
 * The whole database must be deleted rather than just the legacy object store: LocalForage and
 * indexed-vir both use database version 1, so a new object store cannot be added without a version
 * bump, and any bump would then prevent indexed-vir from opening the database at version 1.
 */
function readAndDeleteLegacyStore(databaseName: string): Promise<AnyObject | undefined> {
    return new Promise((resolve, reject) => {
        /**
         * Opening without a version attaches to the existing database without forcing an upgrade.
         * If no database exists, an empty one is created here at version 1 with no object stores.
         */
        const openRequest = indexedDB.open(databaseName);
        openRequest.onerror = () =>
            reject(openRequest.error || new Error(`Failed to open database '${databaseName}'.`));
        openRequest.onsuccess = () => {
            const database = openRequest.result;

            if (!database.objectStoreNames.contains(legacyObjectStoreName)) {
                /**
                 * No legacy data to migrate. If this probe just created an empty database, delete
                 * it so indexed-vir can recreate it with its own object store.
                 */
                const isEmpty = database.objectStoreNames.length === 0;
                database.close();

                if (isEmpty) {
                    deleteDatabase(databaseName).then(() => resolve(undefined), reject);
                } else {
                    resolve(undefined);
                }
                return;
            }

            const cursorRequest = database
                .transaction(legacyObjectStoreName, 'readonly')
                .objectStore(legacyObjectStoreName)
                .openCursor();
            const data: AnyObject = {};

            cursorRequest.onerror = () => {
                database.close();
                reject(
                    cursorRequest.error ||
                        new Error(`Failed to read legacy store in database '${databaseName}'.`),
                );
            };
            cursorRequest.onsuccess = () => {
                const cursor = cursorRequest.result;
                if (cursor) {
                    data[stringify(cursor.key)] = cursor.value;
                    cursor.continue();
                } else {
                    database.close();
                    deleteDatabase(databaseName).then(() => resolve(data), reject);
                }
            };
        };
    });
}

/**
 * Migrates data stored by earlier, LocalForage-backed versions of this package into the given
 * indexed-vir {@link Store}. Safe to call on every client creation: it is a no-op when no legacy
 * data is present.
 *
 * @category Internal
 */
export async function migrateLegacyLocalForageStore(
    databaseName: string,
    store: Readonly<Store>,
): Promise<void> {
    const legacyData = await readAndDeleteLegacyStore(databaseName);

    if (!legacyData) {
        return;
    }

    await Promise.all(
        getObjectTypedEntries(legacyData).map(
            ([
                key,
                value,
            ]) => store.setItem(String(key), value),
        ),
    );
}
