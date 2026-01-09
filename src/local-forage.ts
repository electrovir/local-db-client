import {type AnyObject} from '@augment-vir/common';
import type LocalForageInstance from 'localforage';

import {type Constructor} from 'type-fest';
import LocalForageImport from './localforage/localforage.js';

export const LocalForage = LocalForageImport as unknown as Constructor<typeof LocalForageInstance> &
    typeof LocalForageInstance;

/** Re-export the LocalForage type from the npm package for type annotations. */
export type LocalForage = typeof LocalForageInstance;

export async function iterateLocalForageValues(localForage: Readonly<LocalForage>) {
    const values: AnyObject = {};

    await localForage.iterate((value, key) => {
        values[key] = value;
    });

    return values;
}
