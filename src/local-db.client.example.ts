import {defineShape} from 'object-shape-tester';
import {LocalDbClient} from './index.js';

const myClient = new LocalDbClient({
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

/** Get a stored value. If the stored value is not valid, `undefined` is returned. */
await myClient.get.objectValue();
