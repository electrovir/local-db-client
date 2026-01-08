import {check} from '@augment-vir/assert';
import {
    mapObject,
    mapObjectValues,
    type AnyObject,
    type PartialWithUndefined,
} from '@augment-vir/common';
import {assertValidShape, checkValidShape, type Shape} from 'object-shape-tester';
import {iterateLocalForageValues, LocalForage} from './local-forage.js';

/**
 * Base type for the shapes type parameter in {@link LocalDbClient}.
 *
 * @category Internal
 */
export type BaseLocalDbClientShapes = Record<string, Shape>;

/**
 * Options for `LocalDbClient.get`.
 *
 * @category Internal
 */
export type LocalDbClientGetOptions = PartialWithUndefined<{
    /**
     * If set to `true`, errors will be thrown if JSON cannot be parsed or if the retrieved value
     * does not match its shape.
     *
     * @default false
     */
    throwErrorOnFailure: boolean;
}>;

/**
 * Type for `LocalDbClient.get`.
 *
 * @category Internal
 */
export type LocalDbClientGet<Shapes extends BaseLocalDbClientShapes> = {
    [Key in keyof Shapes]: (
        options?: LocalDbClientGetOptions | undefined,
    ) => Promise<Shapes[Key]['runtimeType'] | undefined>;
};
/**
 * Type for `LocalDbClient.set`.
 *
 * @category Internal
 */
export type LocalDbClientSet<Shapes extends BaseLocalDbClientShapes> = {
    [Key in keyof Shapes]: (
        value: Shapes[Key]['runtimeType'],
    ) => Promise<Shapes[Key]['runtimeType']>;
};
/**
 * Type for `LocalDbClient.delete`.
 *
 * @category Internal
 */
export type LocalDbClientDelete<Shapes extends BaseLocalDbClientShapes> = {
    [Key in keyof Shapes]: () => Promise<void>;
};
/**
 * Type for `LocalDbClient.getAllValues()`.
 *
 * @category Internal
 */
export type LocalDbClientAllValues<Shapes extends BaseLocalDbClientShapes> = Partial<{
    [Key in keyof Shapes]: Shapes[Key]['runtimeType'];
}>;

/**
 * Options for {@link LocalDbClient}.
 *
 * @category Internal
 */
export type LocalDbClientOptions = {
    /** The local storage item name that all values are stored within. */
    storeName: string;
};

/**
 * An interface for storing values into IndexedDB using LocalForage with type safety.
 *
 * @category Main
 */
export class LocalDbClient<const Shapes extends Readonly<BaseLocalDbClientShapes>> {
    constructor(
        protected readonly shapes: Readonly<Shapes>,
        protected readonly options: Readonly<PartialWithUndefined<LocalDbClientOptions>> = {},
    ) {
        this.storeName = options.storeName || 'local-db-client';
        this.localForageStore = LocalForage.createInstance({
            name: this.storeName,
        });

        this.get = mapObjectValues(this.shapes, (key, shapeDefinition) => {
            return async (options: LocalDbClientGetOptions | undefined = {}) => {
                const rawValue = await this.localForageStore.getItem(String(key));

                if (rawValue == undefined) {
                    return undefined;
                }

                if (options.throwErrorOnFailure) {
                    assertValidShape(
                        rawValue,
                        shapeDefinition,
                        {allowExtraKeys: true},
                        `Invalid value at key '${String(key)}'`,
                    );
                } else if (!checkValidShape(rawValue, shapeDefinition, {allowExtraKeys: true})) {
                    return undefined;
                }

                return rawValue;
            };
        });

        this.delete = mapObjectValues(this.shapes, (key) => {
            if (!check.isString(key)) {
                throw new TypeError('Cannot load by non-string key.');
            }

            return async () => {
                await this.localForageStore.removeItem(key);
            };
        });

        this.set = mapObjectValues(this.shapes, (key) => {
            return async (newValue) => {
                if (newValue == undefined) {
                    await this.delete[key]();
                } else {
                    assertValidShape(
                        newValue,
                        this.shapes[key],
                        {allowExtraKeys: true},
                        `LocalDbClient: Invalid value for key '${String(key)}'.`,
                    );
                    await this.localForageStore.setItem(String(key), newValue);
                }

                return newValue;
            };
        });
    }

    private localForageStore: LocalForage;

    public readonly storeName: string;

    /**
     * Get all current values. Any values that have not been set or that are invalid will not be
     * present.
     *
     * @throws If `throwErrorOnFailure` is set to `true` and a value does not match its shape.
     */
    public async getAllValues({throwErrorOnFailure = false}: LocalDbClientGetOptions = {}): Promise<
        LocalDbClientAllValues<Shapes>
    > {
        const rawValues: AnyObject = await iterateLocalForageValues(this.localForageStore);

        return mapObject(rawValues, (key, value) => {
            const shapeDefinition = (
                this.shapes satisfies Record<PropertyKey, Shape> as Record<PropertyKey, Shape>
            )[key];
            if (!shapeDefinition) {
                return undefined;
            }

            if (throwErrorOnFailure) {
                assertValidShape(
                    value,
                    shapeDefinition,
                    {allowExtraKeys: true},
                    `Invalid value at key '${String(key)}'`,
                );
            } else if (!checkValidShape(value, shapeDefinition, {allowExtraKeys: true})) {
                return undefined;
            }

            return {
                key,
                value,
            };
        }) satisfies Partial<Record<keyof Shapes, any>> as LocalDbClientAllValues<Shapes>;
    }

    /** Gets a specific value by key. This will return `undefined` if the */
    public readonly get: LocalDbClientGet<Shapes>;
    /**
     * Set a specific value by key.
     *
     * @throws If the given data does not match the defined shape for it.
     */
    public readonly set: LocalDbClientSet<Shapes>;
    /** Delete a specific value by key. */
    public readonly delete: LocalDbClientDelete<Shapes>;

    /** Clear all values. */
    public async clear() {
        await this.localForageStore.clear();
    }
}
