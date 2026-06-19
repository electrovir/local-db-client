import {check} from '@augment-vir/assert';
import {
    ensureErrorAndPrependMessage,
    makeWritable,
    mapObject,
    mapObjectValues,
    type AnyObject,
    type MaybePromise,
    type Overwrite,
    type PartialWithUndefined,
} from '@augment-vir/common';
import {Store} from 'indexed-vir';
import {assertValidShape, checkValidShape, type Shape} from 'object-shape-tester';
import {defineTypedCustomEvent, defineTypedEvent, ListenTarget} from 'typed-event-target';
import {migrateLegacyLocalForageStore} from './migrate-local-forage.js';

/**
 * Callback type for cleaning values.
 *
 * @category Internal
 */
export type CleanValueCallback<T = unknown> = (currentValue: T) => MaybePromise<
    | {
          shouldUpdate: true;
          newValue: T;
      }
    | {
          shouldUpdate: false;
          newValue?: never;
      }
    | undefined
    | void
>;

/**
 * A single shape definition entry for {@link LocalDbClient}.
 *
 * @category Internal
 */
export type LocalDbClientKeyDefinition = {
    shape: Shape;
    /**
     * Implement this to clean up a value immediately on load. Use {@link defineLocalDbClientKey} to
     * get type safety on this.
     */
    cleanValue?: CleanValueCallback | undefined;
};

/**
 * Use to define a key entry with extra type safety.
 *
 * @category Util
 */
export function defineLocalDbClientKey<const KeyShape extends Shape>(
    shape: KeyShape,
    cleanValue: CleanValueCallback<NoInfer<KeyShape>['runtimeType']>,
): Overwrite<
    LocalDbClientKeyDefinition,
    {
        shape: KeyShape;
    }
> {
    return {
        shape,
        cleanValue,
    };
}

/**
 * Base type for the shapes type parameter in {@link LocalDbClient}.
 *
 * @category Internal
 */
export type BaseLocalDbClientShapes = Record<string, LocalDbClientKeyDefinition>;

/**
 * Options for `LocalDbClient.load`.
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
 * Type for `LocalDbClient.load`.
 *
 * @category Internal
 */
export type LocalDbClientLoad<Shapes extends BaseLocalDbClientShapes> = {
    [Key in keyof Shapes]: (
        options?: LocalDbClientGetOptions | undefined,
    ) => Promise<Shapes[Key]['shape']['runtimeType'] | undefined>;
};

/**
 * Event dispatched when a value is updated in the {@link LocalDbClient}.
 *
 * @category Main
 */
export const LocalDbClientValueUpdateEvent = defineTypedEvent('local-db-client-value-update');

/**
 * Event dispatched when a key's `cleanValue` callback fails: either it throws, or it returns a
 * `newValue` that does not match the key's shape. In both cases the offending value is not
 * persisted and the previous value is kept.
 *
 * @category Main
 */
export const LocalDbClientErrorEvent = defineTypedCustomEvent<{
    /** The key that produced the error. */
    key: PropertyKey;
    /** The error that occurred. */
    error: Error;
}>()('local-db-client-error');

/**
 * Type for `LocalDbClient.set`.
 *
 * @category Internal
 */
export type LocalDbClientSet<Shapes extends BaseLocalDbClientShapes> = {
    [Key in keyof Shapes]: (
        value: Shapes[Key]['shape']['runtimeType'],
    ) => Promise<Shapes[Key]['shape']['runtimeType']>;
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
 * Type for `LocalDbClient.loadAllValues()`.
 *
 * @category Internal
 */
export type LocalDbClientAllValues<Shapes extends BaseLocalDbClientShapes> = Partial<{
    [Key in keyof Shapes]: Shapes[Key]['shape']['runtimeType'];
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
 * An interface for storing values into IndexedDB with type safety.
 *
 * Use the static {@link LocalDbClient.createClient} method to construct an instance.
 *
 * @category Main
 */
export class LocalDbClient<
    const Shapes extends Readonly<BaseLocalDbClientShapes>,
> extends ListenTarget<
    | InstanceType<typeof LocalDbClientValueUpdateEvent>
    | InstanceType<typeof LocalDbClientErrorEvent>
> {
    /**
     * Create a new {@link LocalDbClient} instance. This is the preferred way to construct the client
     * since it awaits loading all initial values.
     */
    public static async createClient<const Shapes extends Readonly<BaseLocalDbClientShapes>>(
        shapes: Readonly<Shapes>,
        options: Readonly<PartialWithUndefined<LocalDbClientOptions>> = {},
    ): Promise<LocalDbClient<Shapes>> {
        const client = new LocalDbClient(shapes, options);
        await migrateLegacyLocalForageStore(client.storeName, client.store);
        await client.loadAllValues();
        return client;
    }

    protected constructor(
        protected readonly shapes: Readonly<Shapes>,
        protected readonly options: Readonly<PartialWithUndefined<LocalDbClientOptions>> = {},
    ) {
        super();
        this.storeName = options.storeName || 'local-db-client';
        this.store = new Store(this.storeName);

        this.load = mapObjectValues(this.shapes, (key, keyDefinition) => {
            return async (options: LocalDbClientGetOptions | undefined = {}) => {
                const rawValue = await this.store.getItem(String(key));

                if (rawValue == undefined) {
                    delete this.value[key];
                    this.dispatch(new LocalDbClientValueUpdateEvent());
                    return undefined;
                }

                if (options.throwErrorOnFailure) {
                    assertValidShape(
                        rawValue,
                        keyDefinition.shape,
                        {
                            allowExtraKeys: true,
                        },
                        `Invalid value at key '${String(key)}'`,
                    );
                } else if (
                    !checkValidShape(rawValue, keyDefinition.shape, {
                        allowExtraKeys: true,
                    })
                ) {
                    delete this.value[key];
                    this.dispatch(new LocalDbClientValueUpdateEvent());
                    return undefined;
                }

                const cleanedValue = await this.cleanValue(key, keyDefinition, rawValue);

                makeWritable(this).value[key] = cleanedValue;
                this.dispatch(new LocalDbClientValueUpdateEvent());
                return cleanedValue;
            };
        });

        this.delete = mapObjectValues(this.shapes, (key) => {
            if (!check.isString(key)) {
                throw new TypeError('Cannot load by non-string key.');
            }

            return async () => {
                await this.store.removeItem(key);
                delete this.value[key];
                this.dispatch(new LocalDbClientValueUpdateEvent());
            };
        });

        this.set = mapObjectValues(this.shapes, (key) => {
            return async (newValue) => {
                if (newValue == undefined) {
                    await this.delete[key]();
                    delete this.value[key];
                } else {
                    assertValidShape(
                        newValue,
                        this.shapes[key].shape,
                        {
                            allowExtraKeys: true,
                        },
                        `LocalDbClient: Invalid value for key '${String(key)}'.`,
                    );
                    await this.store.setItem(String(key), newValue);
                    makeWritable(this).value[key] = newValue;
                }

                this.dispatch(new LocalDbClientValueUpdateEvent());
                return newValue;
            };
        });
    }

    protected store: Store;

    public readonly storeName: string;

    /**
     * The current cached values. Updated whenever other methods update values. Listen to the
     * {@link LocalDbClientValueUpdateEvent} event to know when this has updated.
     */
    public readonly value: Readonly<LocalDbClientAllValues<Shapes>> = {} as Readonly<
        LocalDbClientAllValues<Shapes>
    >;

    /**
     * Get all current values. Any values that have not been set or that are invalid will not be
     * present. Also updates `value`.
     *
     * @throws If `throwErrorOnFailure` is set to `true` and a value does not match its shape.
     */
    public async loadAllValues({
        throwErrorOnFailure = false,
    }: LocalDbClientGetOptions = {}): Promise<LocalDbClientAllValues<Shapes>> {
        const rawValues: AnyObject = {};
        await this.store.iterate((value, key) => {
            rawValues[key] = value;
        });

        const allValues = (await mapObject(rawValues, async (key, value) => {
            const keyDefinition = (
                this.shapes satisfies Record<PropertyKey, LocalDbClientKeyDefinition> as Record<
                    PropertyKey,
                    LocalDbClientKeyDefinition
                >
            )[key];
            if (!keyDefinition) {
                return undefined;
            }

            if (throwErrorOnFailure) {
                assertValidShape(
                    value,
                    keyDefinition.shape,
                    {
                        allowExtraKeys: true,
                    },
                    `Invalid value at key '${String(key)}'`,
                );
            } else if (
                !checkValidShape(value, keyDefinition.shape, {
                    allowExtraKeys: true,
                })
            ) {
                return undefined;
            }

            return {
                key,
                value: await this.cleanValue(key, keyDefinition, value),
            };
        })) satisfies Partial<Record<keyof Shapes, any>> as LocalDbClientAllValues<Shapes>;

        makeWritable(this).value = allValues;
        this.dispatch(new LocalDbClientValueUpdateEvent());

        return allValues;
    }

    /** Runs and validates a keys' `cleanValue` callback. */
    protected async cleanValue<Value>(
        key: PropertyKey,
        keyDefinition: Readonly<LocalDbClientKeyDefinition>,
        currentValue: Value,
    ): Promise<Value> {
        if (!keyDefinition.cleanValue) {
            return currentValue;
        }

        try {
            const cleanResult = await keyDefinition.cleanValue(currentValue);

            if (!cleanResult?.shouldUpdate) {
                return currentValue;
            } else if (
                !checkValidShape(cleanResult.newValue, keyDefinition.shape, {
                    allowExtraKeys: true,
                })
            ) {
                throw new Error('cleanValue callback returned an invalid shape.');
            }

            await this.store.setItem(String(key), cleanResult.newValue);

            return cleanResult.newValue as Value;
        } catch (error) {
            this.dispatch(
                new LocalDbClientErrorEvent({
                    detail: {
                        key: String(key),
                        error: ensureErrorAndPrependMessage(
                            error,
                            'Failed to clean LocalDBClient value.',
                        ),
                    },
                }),
            );
            return currentValue;
        }
    }

    /** Loads a specific value by key from the database and updates `value`. */
    public readonly load: LocalDbClientLoad<Shapes>;
    /**
     * Set a specific value by key. Also updates `value`.
     *
     * @throws If the given data does not match the defined shape for it.
     */
    public readonly set: LocalDbClientSet<Shapes>;
    /** Delete a specific value by key. */
    public readonly delete: LocalDbClientDelete<Shapes>;

    /** Clear all values. */
    public async clear() {
        await this.store.clear();
    }
}
