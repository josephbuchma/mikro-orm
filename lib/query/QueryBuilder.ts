import { QueryBuilder as KnexQueryBuilder, Raw, Transaction, Value } from 'knex';
import { Utils, ValidationError } from '../utils';
import { QueryBuilderHelper } from './QueryBuilderHelper';
import { SmartQueryHelper } from './SmartQueryHelper';
import { AnyEntity, Dictionary, EntityProperty, QBFilterQuery } from '../typings';
import { ReferenceType } from '../entity';
import { FlatQueryOrderMap, QueryFlag, QueryOrderMap, QueryType } from './enums';
import { LockMode } from '../unit-of-work';
import { AbstractSqlDriver } from '../drivers';
import { MetadataStorage } from '../metadata';
import { CriteriaNode } from './internal';
import { EntityManager } from '../EntityManager';

/**
 * SQL query builder
 */
export class QueryBuilder<T extends AnyEntity<T> = AnyEntity> {

  type!: QueryType;
  _fields?: string[];
  _populate: string[] = [];
  _populateMap: Dictionary<string> = {};

  private aliasCounter = 1;
  private flags: Set<QueryFlag> = new Set();
  private finalized = false;
  private _joins: Dictionary<JoinOptions> = {};
  private _aliasMap: Dictionary<string> = {};
  private _schema?: string;
  private _cond: Dictionary = {};
  private _data!: Dictionary;
  private _orderBy: QueryOrderMap = {};
  private _groupBy: string[] = [];
  private _having: Dictionary = {};
  private _limit?: number;
  private _offset?: number;
  private lockMode?: LockMode;
  private readonly platform = this.driver.getPlatform();
  private readonly knex = this.driver.getConnection(this.connectionType).getKnex();
  private readonly helper = new QueryBuilderHelper(this.entityName, this.alias, this._aliasMap, this.metadata, this.knex, this.platform);

  constructor(private readonly entityName: string,
              private readonly metadata: MetadataStorage,
              private readonly driver: AbstractSqlDriver,
              private readonly context?: Transaction,
              readonly alias = `e0`,
              private readonly connectionType?: 'read' | 'write',
              private readonly em?: EntityManager) { }

  select(fields: string | string[], distinct = false): this {
    this._fields = Utils.asArray(fields);

    if (distinct) {
      this.flags.add(QueryFlag.DISTINCT);
    }

    return this.init(QueryType.SELECT);
  }

  addSelect(fields: string | string[]): this {
    return this.select([...Utils.asArray(this._fields), ...Utils.asArray(fields)]);
  }

  insert(data: any): this {
    return this.init(QueryType.INSERT, data);
  }

  update(data: any): this {
    return this.init(QueryType.UPDATE, data);
  }

  delete(cond: QBFilterQuery = {}): this {
    return this.init(QueryType.DELETE, undefined, cond);
  }

  truncate(): this {
    return this.init(QueryType.TRUNCATE);
  }

  count(field?: string | string[], distinct = false): this {
    this._fields = [...(field ? Utils.asArray(field) : this.metadata.get(this.entityName).primaryKeys)];

    if (distinct) {
      this.flags.add(QueryFlag.DISTINCT);
    }

    return this.init(QueryType.COUNT);
  }

  join(field: string, alias: string, cond: QBFilterQuery = {}, type: 'leftJoin' | 'innerJoin' | 'pivotJoin' = 'innerJoin', path?: string): this {
    const extraFields = this.joinReference(field, alias, cond, type, path);
    this._fields!.push(...extraFields);

    return this;
  }

  leftJoin(field: string, alias: string, cond: QBFilterQuery = {}): this {
    return this.join(field, alias, cond, 'leftJoin');
  }

  where(cond: QBFilterQuery<T>, operator?: keyof typeof QueryBuilderHelper.GROUP_OPERATORS): this;
  where(cond: string, params?: any[], operator?: keyof typeof QueryBuilderHelper.GROUP_OPERATORS): this;
  where(cond: QBFilterQuery<T> | string, params?: keyof typeof QueryBuilderHelper.GROUP_OPERATORS | any[], operator?: keyof typeof QueryBuilderHelper.GROUP_OPERATORS): this {
    cond = SmartQueryHelper.processWhere(cond as Dictionary, this.entityName, this.metadata.get(this.entityName, false, false))!;

    if (Utils.isString(cond)) {
      cond = { [`(${cond})`]: Utils.asArray(params) };
      operator = operator || '$and';
    }

    const op = operator || params as keyof typeof QueryBuilderHelper.GROUP_OPERATORS;
    const topLevel = !op || Object.keys(this._cond).length === 0;

    if (topLevel) {
      this._cond = CriteriaNode.create(this.metadata, this.entityName, cond).process(this);
    } else if (Array.isArray(this._cond[op])) {
      this._cond[op].push(CriteriaNode.create(this.metadata, this.entityName, cond).process(this));
    } else {
      const cond1 = [this._cond, CriteriaNode.create(this.metadata, this.entityName, cond).process(this)];
      this._cond = { [op]: cond1 };
    }

    return this;
  }

  andWhere(cond: QBFilterQuery<T>): this;
  andWhere(cond: string, params?: any[]): this;
  andWhere(cond: QBFilterQuery<T> | string, params?: any[]): this {
    return this.where(cond as string, params, '$and');
  }

  orWhere(cond: QBFilterQuery<T>): this;
  orWhere(cond: string, params?: any[]): this;
  orWhere(cond: QBFilterQuery<T> | string, params?: any[]): this {
    return this.where(cond as string, params, '$or');
  }

  orderBy(orderBy: QueryOrderMap): this {
    this._orderBy = CriteriaNode.create(this.metadata, this.entityName, orderBy).process(this);
    return this;
  }

  groupBy(fields: string | string[]): this {
    this._groupBy = Utils.asArray(fields);
    return this;
  }

  having(cond: QBFilterQuery | string, params?: any[]): this {
    if (Utils.isString(cond)) {
      cond = { [`(${cond})`]: Utils.asArray(params) };
    }

    this._having = CriteriaNode.create(this.metadata, this.entityName, cond).process(this);
    return this;
  }

  /**
   * @internal
   */
  populate(populate: string[]): this {
    this._populate = populate;
    return this;
  }

  limit(limit: number, offset = 0): this {
    this._limit = limit;

    if (offset) {
      this.offset(offset);
    }

    return this;
  }

  offset(offset: number): this {
    this._offset = offset;
    return this;
  }

  withSchema(schema?: string): this {
    this._schema = schema;

    return this;
  }

  setLockMode(mode?: LockMode): this {
    if ([LockMode.NONE, LockMode.PESSIMISTIC_READ, LockMode.PESSIMISTIC_WRITE].includes(mode!) && !this.context) {
      throw ValidationError.transactionRequired();
    }

    this.lockMode = mode;

    return this;
  }

  setFlag(flag: QueryFlag): this {
    this.flags.add(flag);
    return this;
  }

  getKnexQuery(): KnexQueryBuilder {
    this.finalize();
    const qb = this.getQueryBase();

    Utils.runIfNotEmpty(() => this.helper.appendQueryCondition(this.type, this._cond, qb), this._cond);
    Utils.runIfNotEmpty(() => qb.groupBy(this.prepareFields(this._groupBy, 'groupBy')), this._groupBy);
    Utils.runIfNotEmpty(() => this.helper.appendQueryCondition(this.type, this._having, qb, undefined, 'having'), this._having);
    Utils.runIfNotEmpty(() => qb.orderBy(this.helper.getQueryOrder(this.type, this._orderBy as FlatQueryOrderMap, this._populateMap)), this._orderBy);
    Utils.runIfNotEmpty(() => qb.limit(this._limit!), this._limit);
    Utils.runIfNotEmpty(() => qb.offset(this._offset!), this._offset);

    if (this.type === QueryType.TRUNCATE && this.platform.usesCascadeStatement()) {
      return this.knex.raw(qb.toSQL().toNative().sql + ' cascade') as any;
    }

    this.helper.getLockSQL(qb, this.lockMode);
    this.helper.finalize(this.type, qb, this.metadata.get(this.entityName, false, false));

    return qb;
  }

  getQuery(): string {
    return this.getKnexQuery().toSQL().toNative().sql;
  }

  getParams(): readonly Value[] {
    return this.getKnexQuery().toSQL().toNative().bindings;
  }

  getAliasForEntity(entityName: string, node: CriteriaNode): string | undefined {
    if (node.prop) {
      const join = Object.values(this._joins).find(j => j.path === node.getPath());

      if (!join) {
        return undefined;
      }
    }

    const found = Object.entries(this._aliasMap).find(([, e]) => e === entityName);

    return found ? found[0] : undefined;
  }

  getNextAlias(): string {
    return `e${this.aliasCounter++}`;
  }

  async execute<U = any>(method: 'all' | 'get' | 'run' = 'all', mapResults = true): Promise<U> {
    const type = this.connectionType || (method === 'run' ? 'write' : 'read');
    const res = await this.driver.getConnection(type).execute(this.getKnexQuery(), [], method);
    const meta = this.metadata.get(this.entityName, false, false);

    if (!mapResults) {
      return res as unknown as U;
    }

    if (method === 'all' && Array.isArray(res)) {
      return res.map(r => this.driver.mapResult(r, meta)) as unknown as U;
    }

    return this.driver.mapResult(res, meta) as unknown as U;
  }

  async getResult(): Promise<T[]> {
    const res = await this.execute<T[]>('all', true);
    return res.map(r => this.em!.map<T>(this.entityName, r));
  }

  async getSingleResult(): Promise<T | null> {
    const res = await this.getResult();
    return res[0] || null;
  }

  clone(): QueryBuilder<T> {
    const qb = new QueryBuilder<T>(this.entityName, this.metadata, this.driver, this.context, this.alias, this.connectionType, this.em);
    Object.assign(qb, this);

    // clone array/object properties
    const properties = ['flags', '_fields', '_populate', '_populateMap', '_joins', '_aliasMap', '_cond', '_data', '_orderBy', '_schema'];
    properties.forEach(prop => (qb as any)[prop] = Utils.copy(this[prop as keyof this]));
    qb.finalized = false;

    return qb;
  }

  getKnex(): KnexQueryBuilder {
    const tableName = this.helper.getTableName(this.entityName) + ([QueryType.SELECT, QueryType.COUNT].includes(this.type) ? ` as ${this.alias}` : '');
    const qb = this.knex(tableName);

    if (this.context) {
      qb.transacting(this.context);
    }

    return qb;
  }

  private joinReference(field: string, alias: string, cond: Dictionary, type: 'leftJoin' | 'innerJoin' | 'pivotJoin', path?: string): string[] {
    const [fromAlias, fromField] = this.helper.splitField(field);
    const entityName = this._aliasMap[fromAlias];
    const prop = this.metadata.get(entityName).properties[fromField];
    this._aliasMap[alias] = prop.type;
    cond = SmartQueryHelper.processWhere(cond, this.entityName, this.metadata.get(this.entityName))!;
    const aliasedName = `${fromAlias}.${prop.name}`;
    const ret: string[] = [];

    if (prop.reference === ReferenceType.ONE_TO_MANY) {
      this._joins[aliasedName] = this.helper.joinOneToReference(prop, fromAlias, alias, type, cond);
    } else if (prop.reference === ReferenceType.MANY_TO_MANY) {
      const pivotAlias = type === 'pivotJoin' ? alias : `e${this.aliasCounter++}`;
      const joins = this.helper.joinManyToManyReference(prop, fromAlias, alias, pivotAlias, type, cond);
      Object.assign(this._joins, joins);
      this._aliasMap[pivotAlias] = prop.pivotTable;
      ret.push(`${fromAlias}.${prop.name}`);
    } else if (prop.reference === ReferenceType.ONE_TO_ONE) {
      this._joins[aliasedName] = this.helper.joinOneToReference(prop, fromAlias, alias, type, cond);
    } else { // MANY_TO_ONE
      this._joins[aliasedName] = this.helper.joinManyToOneReference(prop, fromAlias, alias, type, cond);
    }

    this._joins[aliasedName].path = path;

    return ret;
  }

  private prepareFields<T extends string | Raw = string | Raw>(fields: string[], type: 'where' | 'groupBy' = 'where'): T[] {
    const ret: string[] = [];

    fields.forEach(f => {
      if (this._joins[f] && type === 'where') {
        return ret.push(...this.helper.mapJoinColumns(this.type, this._joins[f]) as string[]);
      }

      ret.push(this.helper.mapper(f, this.type) as string);
    });

    Object.keys(this._populateMap).forEach(f => {
      if (!fields.includes(f) && type === 'where') {
        ret.push(...this.helper.mapJoinColumns(this.type, this._joins[f]) as string[]);
      }

      if (this._joins[f].prop.reference !== ReferenceType.ONE_TO_ONE && this._joins[f].inverseJoinColumns) {
        this._joins[f].inverseJoinColumns!.forEach(inverseJoinColumn => {
          Utils.renameKey(this._cond, inverseJoinColumn, `${this._joins[f].alias}.${inverseJoinColumn!}`);
        });
      }
    });

    return ret as T[];
  }

  private init(type: QueryType, data?: any, cond?: any): this {
    this.type = type;
    this._aliasMap[this.alias] = this.entityName;

    if (data) {
      this._data = this.helper.processData(data);
    }

    if (cond) {
      this._cond = CriteriaNode.create(this.metadata, this.entityName, cond).process(this);
    }

    return this;
  }

  private getQueryBase(): KnexQueryBuilder {
    const qb = this.getKnex();

    if (this._schema) {
      qb.withSchema(this._schema);
    }

    switch (this.type) {
      case QueryType.SELECT:
        qb.select(this.prepareFields(this._fields!));

        if (this.flags.has(QueryFlag.DISTINCT)) {
          qb.distinct();
        }

        this.helper.processJoins(qb, this._joins);
        break;
      case QueryType.COUNT: {
        const m = this.flags.has(QueryFlag.DISTINCT) ? 'countDistinct' : 'count';
        qb[m](this.helper.mapper(this._fields![0], this.type, undefined, 'count'));
        this.helper.processJoins(qb, this._joins);
        break;
      }
      case QueryType.INSERT:
        qb.insert(this._data);
        break;
      case QueryType.UPDATE:
        qb.update(this._data);
        this.helper.updateVersionProperty(qb);
        break;
      case QueryType.DELETE:
        qb.delete();
        break;
      case QueryType.TRUNCATE:
        qb.truncate();
        break;
    }

    return qb;
  }

  private finalize(): void {
    if (this.finalized) {
      return;
    }

    this._populate.forEach(field => {
      const [fromAlias, fromField] = this.helper.splitField(field);
      const aliasedField = `${fromAlias}.${fromField}`;

      if (this._joins[aliasedField] && this.helper.isOneToOneInverse(field)) {
        return this._populateMap[aliasedField] = this._joins[aliasedField].alias;
      }

      if (this.metadata.has(field)) { // pivot table entity
        this.autoJoinPivotTable(field);
      } else if (this.helper.isOneToOneInverse(field)) {
        const prop = this.metadata.get(this.entityName).properties[field];
        this._joins[prop.name] = this.helper.joinOneToReference(prop, this.alias, `e${this.aliasCounter++}`, 'leftJoin');
        this._populateMap[field] = this._joins[field].alias;
      }
    });

    SmartQueryHelper.processParams([this._data, this._cond, this._having]);
    this.finalized = true;
  }

  private autoJoinPivotTable(field: string): void {
    const pivotMeta = this.metadata.get(field);
    const owner = Object.values(pivotMeta.properties).find(prop => prop.reference === ReferenceType.MANY_TO_ONE && prop.owner)!;
    const inverse = Object.values(pivotMeta.properties).find(prop => prop.reference === ReferenceType.MANY_TO_ONE && !prop.owner)!;
    const prop = this._cond[pivotMeta.name + '.' + owner.name] || this._orderBy[pivotMeta.name + '.' + owner.name] ? inverse : owner;
    const pivotAlias = this.getNextAlias();

    this._joins[field] = this.helper.joinPivotTable(field, prop, this.alias, pivotAlias, 'leftJoin');
    Utils.renameKey(this._cond, `${field}.${owner.name}`, Utils.getPrimaryKeyHash(owner.fieldNames.map(fieldName => `${pivotAlias}.${fieldName}`)));
    Utils.renameKey(this._cond, `${field}.${inverse.name}`, Utils.getPrimaryKeyHash(inverse.fieldNames.map(fieldName => `${pivotAlias}.${fieldName}`)));
    this._populateMap[field] = this._joins[field].alias;
  }

}

export interface JoinOptions {
  table: string;
  type: 'leftJoin' | 'innerJoin' | 'pivotJoin';
  alias: string;
  ownerAlias: string;
  inverseAlias?: string;
  joinColumns?: string[];
  inverseJoinColumns?: string[];
  primaryKeys?: string[];
  path?: string;
  prop: EntityProperty;
  cond: Dictionary;
}
