import { QueryOrder } from './query';
import { AssignOptions, Cascade, Collection, EntityRepository, EntityValidator, IdentifiedReference, Reference, ReferenceType } from './entity';
import { EntityManager } from './EntityManager';
import { LockMode } from './unit-of-work';
import { Platform } from './platforms';
import { MetadataStorage } from './metadata';
import { Type } from './types';
import { EntitySchema } from './schema';

export type Constructor<T> = new (...args: any[]) => T;
export type Dictionary<T = any> = { [k: string]: T };

export type PartialEntityProperty<T, P extends keyof T> = null | (T extends Date | RegExp ? T : T[P] | (true extends IsEntity<T[P]> ? PartialEntity<T[P]> | Primary<T[P]> : never));
export type PartialEntity<T> = T extends Reference<infer U> ? { [P in keyof U]?: PartialEntityProperty<U, P> } : { [P in keyof T]?: PartialEntityProperty<T, P> };

export type DeepPartialEntity<T> = {
  [P in keyof T]?: null | (T[P] extends (infer U)[]
    ? DeepPartialEntity<U>[]
    : T[P] extends readonly (infer U)[]
      ? readonly DeepPartialEntity<U>[]
      : T extends Date | RegExp
        ? T
        : DeepPartialEntity<T[P]> | PartialEntity<T[P]> | Primary<T[P]>)
};

export const PrimaryKeyType = Symbol('PrimaryKeyType');
export type Primary<T> = T extends { [PrimaryKeyType]: infer PK }
  ? PK : T extends { _id: infer PK }
  ? PK | string : T extends { uuid: infer PK }
  ? PK : T extends { id: infer PK }
  ? PK : never;
export type PrimaryMap<T extends AnyEntity<T>> = Record<keyof T, Primary<T>>;
export type IPrimaryKeyValue = number | string | bigint | { toHexString(): string };
export type IPrimaryKey<T extends IPrimaryKeyValue = IPrimaryKeyValue> = T;

export type IsScalar<T> = T extends number | string | bigint | Date | RegExp ? true : never;
export type IsEntity<T> = T extends Reference<T> | { [PrimaryKeyType]: any } | { _id: any } | { uuid: string } | { id: number | string | bigint } ? true : never;

export type OneOrArray<T> = T | T[];
export type OperatorMap<T> = {
  $and?: Query<T>[];
  $or?: Query<T>[];
  $eq?: Query<T>;
  $ne?: Query<T>;
  $in?: Query<T>[];
  $nin?: Query<T>[];
  $not?: Query<T>;
  $gt?: Query<T>;
  $gte?: Query<T>;
  $lt?: Query<T>;
  $lte?: Query<T>;
  $like?: string;
  $re?: string;
};
export type StringProp<T> = T extends string ? string | RegExp : never;
export type EntityOrPrimary<T> = true extends IsScalar<T> ? never : DeepPartialEntity<T> | PartialEntity<T> | Primary<T> | T;
export type CollectionItem<T> = T extends Collection<infer K> ? EntityOrPrimary<K> : never;
export type FilterValue<T> = T | OperatorMap<T> | StringProp<T> | OneOrArray<CollectionItem<T> | EntityOrPrimary<T>> | null;
export type Query<T> = true extends IsEntity<T>
  ? { [K in keyof T]?: Query<T[K]> | FilterValue<T[K]> | null } | FilterValue<T>
  : T extends Collection<infer K>
    ? { [KK in keyof K]?: Query<K[KK]> | FilterValue<K[KK]> | null } | FilterValue<K>
    : FilterValue<T>;
export type FilterQuery<T> = Query<T> | { [PrimaryKeyType]?: any };
export type QBFilterQuery<T = any> = FilterQuery<T> & Dictionary;

export interface IWrappedEntity<T, PK extends keyof T> {
  isInitialized(): boolean;
  populated(populated?: boolean): void;
  init(populated?: boolean, lockMode?: LockMode): Promise<this>;
  toReference(): IdentifiedReference<T, PK>;
  toObject(ignoreFields?: string[]): Dictionary;
  toJSON(...args: any[]): Dictionary;
  assign(data: any, options?: AssignOptions | boolean): this;
  __uuid: string;
  __meta: EntityMetadata<T>;
  __internal: { platform: Platform; metadata: MetadataStorage; validator: EntityValidator };
  __data: Dictionary;
  __em?: EntityManager;
  __initialized?: boolean;
  __populated: boolean;
  __lazyInitialized: boolean;
  __primaryKey: PrimaryMap<T>;
  __primaryKeys: Primary<T>[];
  __serializedPrimaryKey: string & keyof T;
}

export type AnyEntity<T = any, PK extends keyof T = keyof T> = { [K in PK]?: T[K] } & { [PrimaryKeyType]?: T[PK] };
export type WrappedEntity<T, PK extends keyof T> = IWrappedEntity<T, PK> & AnyEntity<T, PK>;
export type IdEntity<T extends { id: number | string | bigint }> = AnyEntity<T, 'id'>;
export type UuidEntity<T extends { uuid: string }> = AnyEntity<T, 'uuid'>;
export type MongoEntity<T extends { _id: IPrimaryKey; id: string }> = AnyEntity<T, 'id' | '_id'>;
export type EntityClass<T extends AnyEntity<T>> = Function & { prototype: T };
export type EntityClassGroup<T extends AnyEntity<T>> = { entity: EntityClass<T>; schema: EntityMetadata<T> | EntitySchema<T> };
export type EntityName<T extends AnyEntity<T>> = string | EntityClass<T>;
export type EntityData<T extends AnyEntity<T>> = { [K in keyof T]?: T[K] | Primary<T[K]> | CollectionItem<T[K]>[] } & Dictionary;

export interface EntityProperty<T extends AnyEntity<T> = any> {
  name: string & keyof T;
  entity: () => EntityName<T>;
  type: string;
  columnTypes: string[];
  customType: Type;
  primary: boolean;
  serializedPrimaryKey: boolean;
  length?: any;
  reference: ReferenceType;
  wrappedReference?: boolean;
  fieldNames: string[];
  default?: any;
  index?: boolean | string;
  unique?: boolean | string;
  nullable?: boolean;
  unsigned: boolean;
  persist?: boolean;
  hidden?: boolean;
  enum?: boolean;
  items?: (number | string)[];
  version?: boolean;
  eager?: boolean;
  setter?: boolean;
  getter?: boolean;
  getterName?: keyof T;
  cascade: Cascade[];
  orphanRemoval?: boolean;
  onCreate?: () => any;
  onUpdate?: () => any;
  onDelete?: string;
  onUpdateIntegrity?: string;
  owner: boolean;
  inversedBy: string;
  mappedBy: string;
  orderBy?: { [field: string]: QueryOrder };
  fixedOrder?: boolean;
  fixedOrderColumn?: string;
  pivotTable: string;
  joinColumns: string[];
  inverseJoinColumns: string[];
  referencedColumnNames: string[];
  referencedTableName: string;
}

export type HookType = 'onInit' | 'beforeCreate' | 'afterCreate' | 'beforeUpdate' | 'afterUpdate' | 'beforeDelete' | 'afterDelete';

export interface EntityMetadata<T extends AnyEntity<T> = any> {
  name: string;
  className: string;
  tableName: string;
  pivotTable: boolean;
  constructorParams: string[];
  toJsonParams: string[];
  extends: string;
  collection: string;
  path: string;
  primaryKeys: (keyof T & string)[];
  compositePK: boolean;
  versionProperty: keyof T & string;
  serializedPrimaryKey: keyof T & string;
  properties: { [K in keyof T & string]: EntityProperty<T> };
  indexes: { properties: string | string[]; name?: string; type?: string; options?: Dictionary }[];
  uniques: { properties: string | string[]; name?: string; options?: Dictionary }[];
  customRepository: () => Constructor<EntityRepository<T>>;
  hooks: Partial<Record<HookType, (string & keyof T)[]>>;
  prototype: T;
  class: Constructor<T>;
  abstract: boolean;
  useCache: boolean;
}
