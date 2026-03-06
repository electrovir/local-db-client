# local-db-client

An interface for storing values into IndexedDB with type safety. This uses [localforage](https://www.npmjs.com/package/localforage) under-the-hood.

For a synchronous, but more ephemeral, API using LocalStorage, see [@electrovir/local-storage-client](https://www.npmjs.com/package/@electrovir/local-storage-client)

Reference docs: https://electrovir.github.io/local-db-client

## Instal

```sh
npm i local-db-client
```

## Usage

<!-- example-link: src/local-db.client.example.ts -->

```TypeScript
import {defineShape} from 'object-shape-tester';
import {LocalDbClient} from 'local-db-client';

const myClient = await LocalDbClient.createClient({
    stringValue: defineShape(''),
    numberValue: defineShape(-1),
    booleanValue: defineShape(false),
    objectValue: defineShape({
        name: '',
        age: 0,
        location: '',
    }),
});

/** Set values with type safety. */
await myClient.set.objectValue({
    age: 10,
    location: 'Earth',
    name: 'Example User',
});
await myClient.set.booleanValue(true);

/** Delete a stored value. */
await myClient.delete.booleanValue();

/** Load a stored value. If the stored value is not valid, `undefined` is returned. */
console.info(myClient.value);

/** Force a value to reload. */
await myClient.load.objectValue();
```
