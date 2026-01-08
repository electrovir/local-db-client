// @ts-expect-error: this has no types
import localForageImport from './localforage/localforage.js';

import {type AnyObject} from '@augment-vir/common';
import type * as LocalForageType from 'localforage';

export const LocalForage = localForageImport as typeof LocalForageType;

export async function iterateLocalForageValues(localForage: Readonly<LocalForage>) {
    const values: AnyObject = {};

    await localForage.iterate((value, key) => {
        values[key] = value;
    });

    return values;
}
