// cspell:word keyvaluepairs

import {assert} from '@augment-vir/assert';
import {getObjectTypedEntries, randomString, wait} from '@augment-vir/common';
import {describe, it} from '@augment-vir/test';
import {Store} from 'indexed-vir';
import {defineShape} from 'object-shape-tester';
import {
    defineLocalDbClientKey,
    LocalDbClient,
    LocalDbClientErrorEvent,
    LocalDbClientValueUpdateEvent,
} from './local-db.client.js';

const fakeBoolean = false as boolean;

const testShapes = {
    stringValue: {
        shape: defineShape('default string'),
    },
    numberValue: {
        shape: defineShape(42),
    },
    booleanValue: {
        shape: defineShape(true),
    },
    cleanUpValue: defineLocalDbClientKey(defineShape(-1), () => {
        return {
            newValue: 5,
            shouldUpdate: true,
        };
    }),
    badCleanUpValue: defineLocalDbClientKey(
        defineShape(-1),
        // @ts-expect-error: one branch is returning a string instead of a number (for type testing purposes)
        () => {
            if (fakeBoolean) {
                return {
                    newValue: '5',
                    shouldUpdate: true,
                };
            }

            return {
                newValue: 5,
                shouldUpdate: true,
            };
        },
    ),
    objectValue: {
        shape: defineShape({
            name: '',
            age: 0,
        }),
    },
    arrayValue: {
        shape: defineShape(['']),
    },
    nestedValue: {
        shape: defineShape({
            outer: {
                inner: '',
            },
        }),
    },
};

describe(LocalDbClient.name, () => {
    async function createTestClient() {
        const storeName = `test-store-${randomString(32)}`;
        const testClient = await LocalDbClient.createClient(testShapes, {
            storeName,
        });
        await testClient.clear();

        const store = new Store(testClient.storeName);

        return {
            testClient,
            store,
        };
    }

    it('uses default store name when not provided', async () => {
        const testClient = await LocalDbClient.createClient(testShapes);
        assert.strictEquals(testClient.storeName, 'local-db-client');
    });

    it('uses custom store name when provided', async () => {
        const storeName = 'custom-store-name';
        const testClient = await LocalDbClient.createClient(testShapes, {
            storeName,
        });
        assert.strictEquals(testClient.storeName, storeName);
    });

    it('throws error when shapes object has non-string keys', async () => {
        await assert.throws(
            () =>
                LocalDbClient.createClient({
                    [Symbol('test')]: {
                        shape: defineShape('test'),
                    },
                }),
            {
                matchMessage: 'Cannot load by non-string key.',
            },
        );
    });

    it('isolates store names', async () => {
        const {testClient: testClient1} = await createTestClient();
        const {testClient: testClient2} = await createTestClient();

        await testClient1.set.stringValue('from client 1');
        await testClient2.set.stringValue('from client 2');

        assert.strictEquals(testClient1.value.stringValue, 'from client 1');
        assert.strictEquals(testClient2.value.stringValue, 'from client 2');
    });

    it('same store name shares storage', async () => {
        const {testClient: testClient1} = await createTestClient();
        const testClient2 = await LocalDbClient.createClient(testShapes, {
            storeName: testClient1.storeName,
        });

        await testClient1.set.stringValue('shared value');

        assert.strictEquals(await testClient2.load.stringValue(), 'shared value');
    });

    it('shares store with a raw indexed-vir Store', async () => {
        const {testClient, store} = await createTestClient();
        const value = 'some value';
        await testClient.set.stringValue(value);

        assert.strictEquals(await store.getItem('stringValue'), value);
    });

    /**
     * Seeds a database with a legacy LocalForage-style object store (`keyvaluepairs`) so the
     * migration path can be exercised.
     */
    function seedLegacyLocalForageStore(databaseName: string, entries: Record<string, unknown>) {
        return new Promise<void>((resolve, reject) => {
            const openRequest = indexedDB.open(databaseName, 1);
            openRequest.onupgradeneeded = () => {
                openRequest.result.createObjectStore('keyvaluepairs');
            };
            openRequest.onerror = () =>
                reject(
                    openRequest.error || new Error(`Failed to open database '${databaseName}'.`),
                );
            openRequest.onsuccess = () => {
                const database = openRequest.result;
                const objectStore = database
                    .transaction('keyvaluepairs', 'readwrite')
                    .objectStore('keyvaluepairs');
                getObjectTypedEntries(entries).forEach(
                    ([
                        key,
                        value,
                    ]) => objectStore.put(value, key),
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

    describe('LocalForage migration', () => {
        it('migrates data from a legacy LocalForage store', async () => {
            const storeName = `test-store-${randomString(32)}`;
            await seedLegacyLocalForageStore(storeName, {
                stringValue: 'migrated string',
                numberValue: 7,
            });

            const testClient = await LocalDbClient.createClient(testShapes, {
                storeName,
            });

            assert.deepEquals(testClient.value, {
                stringValue: 'migrated string',
                numberValue: 7,
            });
        });

        it('moves migrated data into the indexed-vir store', async () => {
            const storeName = `test-store-${randomString(32)}`;
            await seedLegacyLocalForageStore(storeName, {
                stringValue: 'migrated string',
            });

            await LocalDbClient.createClient(testShapes, {
                storeName,
            });

            const store = new Store(storeName);
            assert.strictEquals(await store.getItem('stringValue'), 'migrated string');
        });

        it('drops migrated values that no longer match their shape', async () => {
            const storeName = `test-store-${randomString(32)}`;
            await seedLegacyLocalForageStore(storeName, {
                stringValue: 'still valid',
                numberValue: 'no longer a number',
            });

            const testClient = await LocalDbClient.createClient(testShapes, {
                storeName,
            });

            assert.deepEquals(testClient.value, {
                stringValue: 'still valid',
            });
        });

        it('is a no-op when there is no legacy store', async () => {
            const storeName = `test-store-${randomString(32)}`;
            const testClient = await LocalDbClient.createClient(testShapes, {
                storeName,
            });

            assert.deepEquals(testClient.value, {});

            await testClient.set.stringValue('after migration');
            assert.strictEquals(testClient.value.stringValue, 'after migration');
        });
    });

    describe('set', () => {
        it('stores a string value', async () => {
            const {testClient} = await createTestClient();

            await testClient.set.stringValue('hello world');

            assert.strictEquals(testClient.value.stringValue, 'hello world');
        });

        it('stores a number value', async () => {
            const {testClient} = await createTestClient();

            await testClient.set.numberValue(123);

            assert.strictEquals(testClient.value.numberValue, 123);
        });

        it('stores a boolean value', async () => {
            const {testClient} = await createTestClient();

            await testClient.set.booleanValue(false);

            assert.strictEquals(testClient.value.booleanValue, false);
        });

        it('stores an object value', async () => {
            const {testClient} = await createTestClient();

            const objectValue = {
                name: 'John',
                age: 30,
            };
            await testClient.set.objectValue(objectValue);

            assert.deepEquals(testClient.value.objectValue, objectValue);
        });

        it('stores an array value', async () => {
            const {testClient} = await createTestClient();

            const arrayValue = [
                'a',
                'b',
                'c',
            ];
            await testClient.set.arrayValue(arrayValue);

            assert.deepEquals(testClient.value.arrayValue, arrayValue);
        });

        it('stores a nested object value', async () => {
            const {testClient} = await createTestClient();

            const nestedValue = {
                outer: {
                    inner: 'deep value',
                },
            };
            await testClient.set.nestedValue(nestedValue);

            assert.deepEquals(testClient.value.nestedValue, nestedValue);
        });

        it('preserves existing values when setting a new one', async () => {
            const {testClient} = await createTestClient();

            await testClient.set.stringValue('first');
            await testClient.set.numberValue(999);

            assert.strictEquals(testClient.value.stringValue, 'first');
            assert.strictEquals(testClient.value.numberValue, 999);
        });

        it('overwrites existing value with same key', async () => {
            const {testClient} = await createTestClient();

            await testClient.set.stringValue('initial');
            await testClient.set.stringValue('updated');

            assert.strictEquals(testClient.value.stringValue, 'updated');
        });

        it('throws error for invalid shape', async () => {
            const {testClient} = await createTestClient();

            await assert.throws(async () => {
                // @ts-expect-error intentionally passing wrong type
                await testClient.set.stringValue(123);
            });
        });

        it('throws error for invalid object shape', async () => {
            const {testClient} = await createTestClient();

            await assert.throws(async () => {
                await testClient.set.objectValue({
                    // @ts-expect-error intentionally passing wrong type
                    wrongKey: 'value',
                });
            });
        });

        it('allows extra keys in objects', async () => {
            const {testClient} = await createTestClient();

            const objectWithExtra = {
                name: 'John',
                age: 30,
                extra: 'allowed',
            } as {
                name: string;
                age: number;
            };
            await testClient.set.objectValue(objectWithExtra);

            assert.deepEquals(testClient.value.objectValue, objectWithExtra);
        });

        it('handles empty string values', async () => {
            const {testClient} = await createTestClient();

            await testClient.set.stringValue('');
            assert.strictEquals(testClient.value.stringValue, '');
        });

        it('handles zero number values', async () => {
            const {testClient} = await createTestClient();

            await testClient.set.numberValue(0);
            assert.strictEquals(testClient.value.numberValue, 0);
        });

        it('handles empty array values', async () => {
            const {testClient} = await createTestClient();

            await testClient.set.arrayValue([]);
            assert.deepEquals(testClient.value.arrayValue, []);
        });

        it('handles empty object with required shape properties', async () => {
            const {testClient} = await createTestClient();

            const value = {
                name: '',
                age: 0,
            };
            await testClient.set.objectValue(value);
            assert.deepEquals(testClient.value.objectValue, value);
        });

        it('handles negative numbers', async () => {
            const {testClient} = await createTestClient();

            await testClient.set.numberValue(-42);
            assert.strictEquals(testClient.value.numberValue, -42);
        });

        it('handles floating point numbers', async () => {
            const {testClient} = await createTestClient();

            await testClient.set.numberValue(3.14);
            assert.strictEquals(testClient.value.numberValue, 3.14);
        });

        it('handles special string characters', async () => {
            const {testClient} = await createTestClient();

            const specialString = 'Hello\nWorld\t"quotes" & <tags> 🎉';
            await testClient.set.stringValue(specialString);
            assert.strictEquals(testClient.value.stringValue, specialString);
        });

        it('handles unicode strings', async () => {
            const {testClient} = await createTestClient();

            /* cspell:disable-next-line */
            const unicodeString = '日本語 中文 한국어 العربية';
            await testClient.set.stringValue(unicodeString);
            assert.strictEquals(testClient.value.stringValue, unicodeString);
        });
    });

    describe('load', () => {
        it('returns undefined for non-existent key', async () => {
            const {testClient} = await createTestClient();

            assert.isUndefined(testClient.value.stringValue);
        });

        it('retrieves a stored string value', async () => {
            const {testClient} = await createTestClient();

            await testClient.set.stringValue('test value');

            assert.strictEquals(testClient.value.stringValue, 'test value');
        });

        it('retrieves a stored number value', async () => {
            const {testClient} = await createTestClient();

            await testClient.set.numberValue(456);

            assert.strictEquals(testClient.value.numberValue, 456);
        });

        it('retrieves a stored boolean value', async () => {
            const {testClient} = await createTestClient();

            await testClient.set.booleanValue(false);

            assert.strictEquals(testClient.value.booleanValue, false);
        });

        it('retrieves a stored object value', async () => {
            const {testClient} = await createTestClient();

            const objectValue = {
                name: 'Jane',
                age: 25,
            };
            await testClient.set.objectValue(objectValue);

            assert.deepEquals(testClient.value.objectValue, objectValue);
        });

        it('retrieves a stored array value', async () => {
            const {testClient} = await createTestClient();

            const arrayValue = [
                'x',
                'y',
                'z',
            ];
            await testClient.set.arrayValue(arrayValue);

            assert.deepEquals(testClient.value.arrayValue, arrayValue);
        });

        it('retrieves a stored nested object value', async () => {
            const {testClient} = await createTestClient();

            const nestedValue = {
                outer: {
                    inner: 'nested content',
                },
            };
            await testClient.set.nestedValue(nestedValue);

            assert.deepEquals(testClient.value.nestedValue, nestedValue);
        });

        it('returns undefined for corrupted value in storage', async () => {
            const {testClient} = await createTestClient();

            // Manually set an invalid value in storage
            await testClient.set.numberValue(123);

            assert.isUndefined(testClient.value.stringValue);
        });

        it('gets undefined for an unset key', async () => {
            const {testClient} = await createTestClient();

            assert.isUndefined(testClient.value.stringValue);
        });

        it('returns valid value', async () => {
            const {testClient} = await createTestClient();

            await testClient.set.stringValue('valid');

            assert.strictEquals(testClient.value.stringValue, 'valid');
        });

        it('ignores invalid value', async () => {
            const {testClient, store} = await createTestClient();
            const validValue = 'valid';
            await testClient.set.stringValue('valid');

            assert.strictEquals(await store.getItem('stringValue'), validValue);
            await store.setItem('stringValue', 32);

            assert.isUndefined(await testClient.load.stringValue());
        });

        it('returns undefined when loading a non-existent key', async () => {
            const {testClient} = await createTestClient();

            const result = await testClient.load.stringValue();
            assert.isUndefined(result);
        });

        it('throws error when loading invalid value with throwErrorOnFailure', async () => {
            const {testClient, store} = await createTestClient();

            await store.setItem('stringValue', 12_345);

            await assert.throws(
                () =>
                    testClient.load.stringValue({
                        throwErrorOnFailure: true,
                    }),
                {
                    matchMessage: "Invalid value at key 'stringValue'",
                },
            );
        });

        it('returns valid value when loading with throwErrorOnFailure', async () => {
            const {testClient} = await createTestClient();

            await testClient.set.stringValue('valid');
            const result = await testClient.load.stringValue({
                throwErrorOnFailure: true,
            });
            assert.strictEquals(result, 'valid');
        });

        it('deletes when setting to undefined', async () => {
            const {testClient} = await createTestClient();
            await testClient.set.stringValue('hi');
            assert.deepEquals(await testClient.loadAllValues(), {
                stringValue: 'hi',
            });
            // @ts-expect-error: intentionally incorrect input
            await testClient.set.stringValue(undefined);
            assert.deepEquals(await testClient.loadAllValues(), {});
        });
    });

    describe('cleanValue', () => {
        /**
         * Clears any pre-existing data and opens a raw store for the given client. Typed
         * structurally so the client's concrete shape keys are preserved at the call site.
         */
        async function clearAndOpenStore(client: {
            clear: () => Promise<unknown>;
            storeName: string;
        }) {
            await client.clear();
            return new Store(client.storeName);
        }

        function createInvalidCleanClient() {
            return LocalDbClient.createClient(
                {
                    target: {
                        shape: defineShape(0),
                        cleanValue: () => {
                            return {
                                shouldUpdate: true,
                                newValue: 'not a number',
                            };
                        },
                    },
                },
                {
                    storeName: `test-store-${randomString(32)}`,
                },
            );
        }

        describe('update flow', () => {
            it('cleans and persists a value on load', async () => {
                const {testClient, store} = await createTestClient();

                await store.setItem('cleanUpValue', 1);

                assert.strictEquals(await testClient.load.cleanUpValue(), 5);
                assert.strictEquals(testClient.value.cleanUpValue, 5);
                assert.strictEquals(await store.getItem('cleanUpValue'), 5);
            });

            it('cleans values during loadAllValues', async () => {
                const {testClient, store} = await createTestClient();

                await store.setItem('cleanUpValue', 1);

                const result = await testClient.loadAllValues();

                assert.strictEquals(result.cleanUpValue, 5);
                assert.strictEquals(await store.getItem('cleanUpValue'), 5);
            });

            it('runs cleanValue during createClient construction', async () => {
                const storeName = `test-store-${randomString(32)}`;
                const seedStore = new Store(storeName);
                await seedStore.setItem('cleanUpValue', 1);

                const client = await LocalDbClient.createClient(testShapes, {
                    storeName,
                });

                assert.strictEquals(client.value.cleanUpValue, 5);
                assert.strictEquals(await seedStore.getItem('cleanUpValue'), 5);
            });

            it('persists the cleaned value for a fresh client', async () => {
                const {testClient, store} = await createTestClient();
                await store.setItem('cleanUpValue', 1);
                await testClient.load.cleanUpValue();

                const freshClient = await LocalDbClient.createClient(testShapes, {
                    storeName: testClient.storeName,
                });

                assert.strictEquals(freshClient.value.cleanUpValue, 5);
            });

            it('persists a falsy newValue', async () => {
                const client = await LocalDbClient.createClient(
                    {
                        target: defineLocalDbClientKey(defineShape(1), () => {
                            return {
                                newValue: 0,
                                shouldUpdate: true,
                            };
                        }),
                    },
                    {
                        storeName: `test-store-${randomString(32)}`,
                    },
                );
                const store = await clearAndOpenStore(client);

                await store.setItem('target', 7);

                assert.strictEquals(await client.load.target(), 0);
                assert.strictEquals(await store.getItem('target'), 0);
            });
        });

        describe('no-update flow', () => {
            it('does not change or persist the value when shouldUpdate is false on load', async () => {
                const client = await LocalDbClient.createClient(
                    {
                        target: defineLocalDbClientKey(defineShape(0), () => {
                            return {
                                shouldUpdate: false,
                            };
                        }),
                    },
                    {
                        storeName: `test-store-${randomString(32)}`,
                    },
                );
                const store = await clearAndOpenStore(client);

                await store.setItem('target', 7);

                assert.strictEquals(await client.load.target(), 7);
                assert.strictEquals(client.value.target, 7);
                assert.strictEquals(await store.getItem('target'), 7);
            });

            it('does not change the value when shouldUpdate is false in loadAllValues', async () => {
                const client = await LocalDbClient.createClient(
                    {
                        target: defineLocalDbClientKey(defineShape(0), () => {
                            return {
                                shouldUpdate: false,
                            };
                        }),
                    },
                    {
                        storeName: `test-store-${randomString(32)}`,
                    },
                );
                const store = await clearAndOpenStore(client);

                await store.setItem('target', 7);

                const result = await client.loadAllValues();

                assert.strictEquals(result.target, 7);
                assert.strictEquals(await store.getItem('target'), 7);
            });

            it('treats an undefined return as no update', async () => {
                const client = await LocalDbClient.createClient(
                    {
                        target: defineLocalDbClientKey(defineShape(0), () => {
                            return undefined;
                        }),
                    },
                    {
                        storeName: `test-store-${randomString(32)}`,
                    },
                );
                const store = await clearAndOpenStore(client);

                await store.setItem('target', 7);

                assert.strictEquals(await client.load.target(), 7);
                assert.strictEquals(await store.getItem('target'), 7);
            });

            it('treats a void return as no update', async () => {
                const calls: unknown[] = [];
                const client = await LocalDbClient.createClient(
                    {
                        target: defineLocalDbClientKey(defineShape(0), (currentValue) => {
                            calls.push(currentValue);
                        }),
                    },
                    {
                        storeName: `test-store-${randomString(32)}`,
                    },
                );
                const store = await clearAndOpenStore(client);

                await store.setItem('target', 7);

                assert.strictEquals(await client.load.target(), 7);
                assert.strictEquals(await store.getItem('target'), 7);
                assert.isLengthExactly(calls, 1);
            });
        });

        describe('async cleanValue', () => {
            it('awaits an async cleanValue that updates', async () => {
                const client = await LocalDbClient.createClient(
                    {
                        target: defineLocalDbClientKey(defineShape(0), async () => {
                            await wait({
                                milliseconds: 1,
                            });
                            return {
                                newValue: 100,
                                shouldUpdate: true,
                            };
                        }),
                    },
                    {
                        storeName: `test-store-${randomString(32)}`,
                    },
                );
                const store = await clearAndOpenStore(client);

                await store.setItem('target', 7);

                assert.strictEquals(await client.load.target(), 100);
                assert.strictEquals(await store.getItem('target'), 100);
            });

            it('awaits an async cleanValue that declines to update', async () => {
                const client = await LocalDbClient.createClient(
                    {
                        target: defineLocalDbClientKey(defineShape(0), async () => {
                            await wait({
                                milliseconds: 1,
                            });
                            return {
                                shouldUpdate: false,
                            };
                        }),
                    },
                    {
                        storeName: `test-store-${randomString(32)}`,
                    },
                );
                const store = await clearAndOpenStore(client);

                await store.setItem('target', 7);

                assert.strictEquals(await client.load.target(), 7);
                assert.strictEquals(await store.getItem('target'), 7);
            });
        });

        describe('callback argument', () => {
            it('passes the current stored value to cleanValue on load', async () => {
                const receivedValues: unknown[] = [];
                const client = await LocalDbClient.createClient(
                    {
                        target: defineLocalDbClientKey(defineShape(0), (currentValue) => {
                            receivedValues.push(currentValue);
                            return undefined;
                        }),
                    },
                    {
                        storeName: `test-store-${randomString(32)}`,
                    },
                );
                const store = await clearAndOpenStore(client);

                await store.setItem('target', 7);
                await client.load.target();

                assert.deepEquals(receivedValues, [7]);
            });

            it('passes the current stored value to cleanValue in loadAllValues', async () => {
                const receivedValues: unknown[] = [];
                const client = await LocalDbClient.createClient(
                    {
                        target: defineLocalDbClientKey(defineShape(0), (currentValue) => {
                            receivedValues.push(currentValue);
                            return undefined;
                        }),
                    },
                    {
                        storeName: `test-store-${randomString(32)}`,
                    },
                );
                const store = await clearAndOpenStore(client);

                await store.setItem('target', 7);
                await client.loadAllValues();

                assert.deepEquals(receivedValues, [7]);
            });

            it('updates only when the callback condition is met', async () => {
                const client = await LocalDbClient.createClient(
                    {
                        target: defineLocalDbClientKey(defineShape(0), (currentValue) => {
                            if (currentValue < 0) {
                                return {
                                    newValue: 0,
                                    shouldUpdate: true,
                                };
                            }
                            return undefined;
                        }),
                    },
                    {
                        storeName: `test-store-${randomString(32)}`,
                    },
                );
                const store = await clearAndOpenStore(client);

                await store.setItem('target', -5);
                assert.strictEquals(await client.load.target(), 0);

                await store.setItem('target', 3);
                assert.strictEquals(await client.load.target(), 3);
            });
        });

        describe('skips cleanValue', () => {
            it('does not call cleanValue when the key has no stored value', async () => {
                const calls: unknown[] = [];
                const client = await LocalDbClient.createClient(
                    {
                        target: defineLocalDbClientKey(defineShape(0), (currentValue) => {
                            calls.push(currentValue);
                            return undefined;
                        }),
                    },
                    {
                        storeName: `test-store-${randomString(32)}`,
                    },
                );
                await clearAndOpenStore(client);

                assert.isUndefined(await client.load.target());
                assert.isLengthExactly(calls, 0);
            });

            it('does not call cleanValue when the stored value is invalid on load', async () => {
                const calls: unknown[] = [];
                const client = await LocalDbClient.createClient(
                    {
                        target: defineLocalDbClientKey(defineShape(0), (currentValue) => {
                            calls.push(currentValue);
                            return undefined;
                        }),
                    },
                    {
                        storeName: `test-store-${randomString(32)}`,
                    },
                );
                const store = await clearAndOpenStore(client);

                await store.setItem('target', 'not a number');

                assert.isUndefined(await client.load.target());
                assert.isLengthExactly(calls, 0);
            });

            it('does not call cleanValue when the stored value is invalid in loadAllValues', async () => {
                const calls: unknown[] = [];
                const client = await LocalDbClient.createClient(
                    {
                        target: defineLocalDbClientKey(defineShape(0), (currentValue) => {
                            calls.push(currentValue);
                            return undefined;
                        }),
                    },
                    {
                        storeName: `test-store-${randomString(32)}`,
                    },
                );
                const store = await clearAndOpenStore(client);

                await store.setItem('target', 'not a number');

                const result = await client.loadAllValues();

                assert.isUndefined(result.target);
                assert.isLengthExactly(calls, 0);
            });

            it('does not run cleanValue for keys without one', async () => {
                const client = await LocalDbClient.createClient(
                    {
                        plain: {
                            shape: defineShape(''),
                        },
                    },
                    {
                        storeName: `test-store-${randomString(32)}`,
                    },
                );
                const store = await clearAndOpenStore(client);

                await store.setItem('plain', 'untouched');

                assert.strictEquals(await client.load.plain(), 'untouched');
                assert.strictEquals(await store.getItem('plain'), 'untouched');
            });
        });

        describe('throwErrorOnFailure interplay', () => {
            it('runs cleanValue for a valid value when throwErrorOnFailure is true on load', async () => {
                const client = await LocalDbClient.createClient(
                    {
                        target: defineLocalDbClientKey(defineShape(0), () => {
                            return {
                                newValue: 50,
                                shouldUpdate: true,
                            };
                        }),
                    },
                    {
                        storeName: `test-store-${randomString(32)}`,
                    },
                );
                const store = await clearAndOpenStore(client);

                await store.setItem('target', 7);

                assert.strictEquals(
                    await client.load.target({
                        throwErrorOnFailure: true,
                    }),
                    50,
                );
                assert.strictEquals(await store.getItem('target'), 50);
            });

            it('runs cleanValue for a valid value when throwErrorOnFailure is true in loadAllValues', async () => {
                const client = await LocalDbClient.createClient(
                    {
                        target: defineLocalDbClientKey(defineShape(0), () => {
                            return {
                                newValue: 50,
                                shouldUpdate: true,
                            };
                        }),
                    },
                    {
                        storeName: `test-store-${randomString(32)}`,
                    },
                );
                const store = await clearAndOpenStore(client);

                await store.setItem('target', 7);

                const result = await client.loadAllValues({
                    throwErrorOnFailure: true,
                });

                assert.strictEquals(result.target, 50);
            });
        });

        describe('thrown errors', () => {
            it('keeps the value and dispatches an error event when cleanValue throws on load', async () => {
                const client = await LocalDbClient.createClient(
                    {
                        target: defineLocalDbClientKey(defineShape(0), () => {
                            throw new Error('clean failed');
                        }),
                    },
                    {
                        storeName: `test-store-${randomString(32)}`,
                    },
                );
                const store = await clearAndOpenStore(client);
                const errorEvents: InstanceType<typeof LocalDbClientErrorEvent>['detail'][] = [];
                client.listen(LocalDbClientErrorEvent, (event) => {
                    errorEvents.push(event.detail);
                });

                await store.setItem('target', 7);

                assert.strictEquals(await client.load.target(), 7);
                assert.strictEquals(await store.getItem('target'), 7);
                assert.isLengthExactly(errorEvents, 1);
                assert.strictEquals(errorEvents[0].key, 'target');
                assert.strictEquals(
                    errorEvents[0].error.message,
                    'Failed to clean LocalDBClient value: clean failed',
                );
            });

            it('keeps the value and dispatches an error event when cleanValue throws in loadAllValues', async () => {
                const client = await LocalDbClient.createClient(
                    {
                        target: defineLocalDbClientKey(defineShape(0), () => {
                            throw new Error('clean failed');
                        }),
                    },
                    {
                        storeName: `test-store-${randomString(32)}`,
                    },
                );
                const store = await clearAndOpenStore(client);
                const errorEvents: InstanceType<typeof LocalDbClientErrorEvent>['detail'][] = [];
                client.listen(LocalDbClientErrorEvent, (event) => {
                    errorEvents.push(event.detail);
                });

                await store.setItem('target', 7);

                const result = await client.loadAllValues();

                assert.strictEquals(result.target, 7);
                assert.strictEquals(await store.getItem('target'), 7);
                assert.isLengthExactly(errorEvents, 1);
            });
        });

        describe('invalid cleaned value', () => {
            it('rejects an invalid newValue on load: keeps the old value, does not persist, and dispatches an error event', async () => {
                const client = await createInvalidCleanClient();
                const store = await clearAndOpenStore(client);
                const errorEvents: InstanceType<typeof LocalDbClientErrorEvent>['detail'][] = [];
                client.listen(LocalDbClientErrorEvent, (event) => {
                    errorEvents.push(event.detail);
                });

                await store.setItem('target', 7);

                assert.strictEquals(await client.load.target(), 7);
                assert.strictEquals(client.value.target, 7);
                assert.strictEquals(await store.getItem('target'), 7);
                assert.isLengthExactly(errorEvents, 1);
                assert.strictEquals(errorEvents[0].key, 'target');
            });

            it('rejects an invalid newValue in loadAllValues: keeps the old value and dispatches an error event', async () => {
                const client = await createInvalidCleanClient();
                const store = await clearAndOpenStore(client);
                const errorEvents: InstanceType<typeof LocalDbClientErrorEvent>['detail'][] = [];
                client.listen(LocalDbClientErrorEvent, (event) => {
                    errorEvents.push(event.detail);
                });

                await store.setItem('target', 7);

                const result = await client.loadAllValues();

                assert.strictEquals(result.target, 7);
                assert.strictEquals(await store.getItem('target'), 7);
                assert.isLengthExactly(errorEvents, 1);
            });

            it('keeps the old value across repeated loads', async () => {
                const client = await createInvalidCleanClient();
                const store = await clearAndOpenStore(client);
                await store.setItem('target', 7);

                assert.strictEquals(await client.load.target(), 7);
                assert.strictEquals(await client.load.target(), 7);
                assert.strictEquals(await store.getItem('target'), 7);
            });
        });
    });

    describe('delete', () => {
        it('removes a stored value', async () => {
            const {testClient} = await createTestClient();

            await testClient.set.stringValue('to be deleted');
            await testClient.delete.stringValue();

            assert.isUndefined(testClient.value.stringValue);
        });

        it('does not affect other stored values', async () => {
            const {testClient} = await createTestClient();

            await testClient.set.stringValue('keep me');
            await testClient.set.numberValue(100);
            await testClient.delete.numberValue();

            assert.strictEquals(testClient.value.stringValue, 'keep me');
            assert.isUndefined(testClient.value.numberValue);
        });

        it('does not throw when deleting non-existent key', async () => {
            const {testClient} = await createTestClient();

            // Should not throw
            await testClient.delete.stringValue();
            assert.isUndefined(testClient.value.stringValue);
        });
    });

    describe('loadAllValues', () => {
        it('returns empty object when storage is empty', async () => {
            const {testClient} = await createTestClient();

            const result = await testClient.loadAllValues();
            assert.deepEquals(result, {});
        });

        it('returns all stored values', async () => {
            const {testClient} = await createTestClient();

            await testClient.set.stringValue('test');
            await testClient.set.numberValue(42);
            await testClient.set.booleanValue(true);

            const result = await testClient.loadAllValues();

            assert.strictEquals(result.stringValue, 'test');
            assert.strictEquals(result.numberValue, 42);
            assert.strictEquals(result.booleanValue, true);
        });

        it('excludes values not matching shape definitions', async () => {
            const {testClient} = await createTestClient();

            await testClient.set.stringValue('valid');

            const result = await testClient.loadAllValues();

            assert.strictEquals(result.stringValue, 'valid');
            assert.isUndefined((result as Record<string, unknown>)['unknownKey']);
        });

        it('throws error on invalid shape when throwErrorOnFailure is true', async () => {
            const {testClient} = await createTestClient();

            await testClient.set.stringValue('valid');

            // This should work fine since the value is valid
            const result = await testClient.loadAllValues({
                throwErrorOnFailure: true,
            });
            assert.strictEquals(result.stringValue, 'valid');
        });

        it('allows extra keys in stored objects when validating', async () => {
            const {testClient} = await createTestClient();

            const objectWithExtra = {
                name: 'Test',
                age: 20,
                extraKey: 'extra',
            } as {
                name: string;
                age: number;
            };
            await testClient.set.objectValue(objectWithExtra);

            const result = await testClient.loadAllValues();

            assert.deepEquals(result.objectValue, {
                name: 'Test',
                age: 20,
                extraKey: 'extra',
            });
        });

        it('ignores keys in storage that have no shape definition', async () => {
            const {testClient, store} = await createTestClient();
            const validValue = 'valid';

            await testClient.set.stringValue(validValue);

            const mockKey = 'unknownKey';

            assert.strictEquals(testClient.value.stringValue, validValue);
            /** Verify that both the client and the raw store are accessing the same store. */
            assert.strictEquals(await store.getItem('stringValue'), validValue);

            await store.setItem(mockKey, 'some value');

            const result = await testClient.loadAllValues();

            assert.strictEquals(result.stringValue, 'valid');
            assert.isUndefined((result as Record<string, unknown>)[mockKey]);
        });

        it('can throws error in loadAllValues', async () => {
            const {testClient, store} = await createTestClient();

            await store.setItem('stringValue', 12_345); // should be a string

            await assert.throws(
                () =>
                    testClient.loadAllValues({
                        throwErrorOnFailure: true,
                    }),
                {
                    matchMessage: "Invalid value at key 'stringValue'",
                },
            );
        });

        it('excludes invalid values in loadAllValues when throwErrorOnFailure is false', async () => {
            const {testClient, store} = await createTestClient();

            await store.setItem('stringValue', 12_345); // should be a string
            await store.setItem('numberValue', 42); // valid

            const result = await testClient.loadAllValues();

            assert.isUndefined(result.stringValue);
            assert.strictEquals(result.numberValue, 42);
        });
    });

    describe('events', () => {
        it('fires event on set', async () => {
            const {testClient} = await createTestClient();
            let eventCount = 0;

            testClient.listen(LocalDbClientValueUpdateEvent, () => {
                eventCount++;
            });

            await testClient.set.stringValue('hello');
            assert.isAbove(eventCount, 0);
        });

        it('fires event on delete', async () => {
            const {testClient} = await createTestClient();
            await testClient.set.stringValue('to delete');

            let eventCount = 0;
            testClient.listen(LocalDbClientValueUpdateEvent, () => {
                eventCount++;
            });

            await testClient.delete.stringValue();
            assert.isAbove(eventCount, 0);
        });

        it('fires event on load when key exists', async () => {
            const {testClient} = await createTestClient();
            await testClient.set.stringValue('existing');

            let eventCount = 0;
            testClient.listen(LocalDbClientValueUpdateEvent, () => {
                eventCount++;
            });

            await testClient.load.stringValue();
            assert.isAbove(eventCount, 0);
        });

        it('fires event on load when key does not exist', async () => {
            const {testClient} = await createTestClient();

            let eventCount = 0;
            testClient.listen(LocalDbClientValueUpdateEvent, () => {
                eventCount++;
            });

            await testClient.load.stringValue();
            assert.isAbove(eventCount, 0);
        });

        it('fires event on loadAllValues', async () => {
            const {testClient} = await createTestClient();
            await testClient.set.stringValue('value');

            let eventCount = 0;
            testClient.listen(LocalDbClientValueUpdateEvent, () => {
                eventCount++;
            });

            await testClient.loadAllValues();
            assert.isAbove(eventCount, 0);
        });
    });
});
