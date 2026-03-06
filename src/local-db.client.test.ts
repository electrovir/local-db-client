import {assert} from '@augment-vir/assert';
import {randomString} from '@augment-vir/common';
import {describe, it} from '@augment-vir/test';
import {defineShape} from 'object-shape-tester';
import {LocalDbClient, LocalDbClientValueUpdateEvent} from './local-db.client.js';
import {LocalForage} from './local-forage.js';

const testShapes = {
    stringValue: defineShape('default string'),
    numberValue: defineShape(42),
    booleanValue: defineShape(true),
    objectValue: defineShape({
        name: '',
        age: 0,
    }),
    arrayValue: defineShape(['']),
    nestedValue: defineShape({
        outer: {
            inner: '',
        },
    }),
};

describe(LocalDbClient.name, () => {
    async function createTestClient() {
        const storeName = `test-store-${randomString(32)}`;
        const testClient = await LocalDbClient.createClient(testShapes, {storeName});
        await testClient.clear();

        const localForage = LocalForage.createInstance({
            name: testClient.storeName,
        });

        return {testClient, localForage};
    }

    it('uses default store name when not provided', async () => {
        const testClient = await LocalDbClient.createClient(testShapes);
        assert.strictEquals(testClient.storeName, 'local-db-client');
    });

    it('uses custom store name when provided', async () => {
        const storeName = 'custom-store-name';
        const testClient = await LocalDbClient.createClient(testShapes, {storeName});
        assert.strictEquals(testClient.storeName, storeName);
    });

    it('throws error when shapes object has non-string keys', async () => {
        await assert.throws(
            () =>
                LocalDbClient.createClient({
                    [Symbol('test')]: defineShape('test'),
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

    it('shares store with LocalForage', async () => {
        const {testClient, localForage} = await createTestClient();
        const value = 'some value';
        await testClient.set.stringValue(value);

        assert.strictEquals(await localForage.getItem('stringValue'), value);
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

            const objectValue = {name: 'John', age: 30};
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

            const nestedValue = {outer: {inner: 'deep value'}};
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
                // @ts-expect-error intentionally passing wrong type
                await testClient.set.objectValue({wrongKey: 'value'});
            });
        });

        it('allows extra keys in objects', async () => {
            const {testClient} = await createTestClient();

            const objectWithExtra = {name: 'John', age: 30, extra: 'allowed'} as {
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

            const objectValue = {name: 'Jane', age: 25};
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

            const nestedValue = {outer: {inner: 'nested content'}};
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
            const {testClient, localForage} = await createTestClient();
            const validValue = 'valid';
            await testClient.set.stringValue('valid');

            assert.strictEquals(await localForage.getItem('stringValue'), validValue);
            await localForage.setItem('stringValue', 32);

            assert.isUndefined(await testClient.load.stringValue());
        });

        it('returns undefined when loading a non-existent key', async () => {
            const {testClient} = await createTestClient();

            const result = await testClient.load.stringValue();
            assert.isUndefined(result);
        });

        it('throws error when loading invalid value with throwErrorOnFailure', async () => {
            const {testClient, localForage} = await createTestClient();

            await localForage.setItem('stringValue', 12_345);

            await assert.throws(() => testClient.load.stringValue({throwErrorOnFailure: true}), {
                matchMessage: "Invalid value at key 'stringValue'",
            });
        });

        it('returns valid value when loading with throwErrorOnFailure', async () => {
            const {testClient} = await createTestClient();

            await testClient.set.stringValue('valid');
            const result = await testClient.load.stringValue({throwErrorOnFailure: true});
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
            const result = await testClient.loadAllValues({throwErrorOnFailure: true});
            assert.strictEquals(result.stringValue, 'valid');
        });

        it('allows extra keys in stored objects when validating', async () => {
            const {testClient} = await createTestClient();

            const objectWithExtra = {name: 'Test', age: 20, extraKey: 'extra'} as {
                name: string;
                age: number;
            };
            await testClient.set.objectValue(objectWithExtra);

            const result = await testClient.loadAllValues();

            assert.deepEquals(result.objectValue, {name: 'Test', age: 20, extraKey: 'extra'});
        });

        it('ignores keys in storage that have no shape definition', async () => {
            const {testClient, localForage} = await createTestClient();
            const validValue = 'valid';

            await testClient.set.stringValue(validValue);

            const mockKey = 'unknownKey';

            assert.strictEquals(testClient.value.stringValue, validValue);
            /** Verify that both the client and the localForage are accessing the same store. */
            assert.strictEquals(await localForage.getItem('stringValue'), validValue);

            await localForage.setItem(mockKey, 'some value');

            const result = await testClient.loadAllValues();

            assert.strictEquals(result.stringValue, 'valid');
            assert.isUndefined((result as Record<string, unknown>)[mockKey]);
        });

        it('can throws error in loadAllValues', async () => {
            const {testClient, localForage} = await createTestClient();

            await localForage.setItem('stringValue', 12_345); // should be a string

            await assert.throws(() => testClient.loadAllValues({throwErrorOnFailure: true}), {
                matchMessage: "Invalid value at key 'stringValue'",
            });
        });

        it('excludes invalid values in loadAllValues when throwErrorOnFailure is false', async () => {
            const {testClient, localForage} = await createTestClient();

            await localForage.setItem('stringValue', 12_345); // should be a string
            await localForage.setItem('numberValue', 42); // valid

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
