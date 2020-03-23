import Knex, { JoinClause, QueryBuilder as KnexQueryBuilder, Raw } from 'knex';
import { inspect } from 'util';

import { Utils, ValidationError } from '../utils';
import { Dictionary, EntityMetadata, EntityProperty } from '../typings';
import { FlatQueryOrderMap, QueryOrderNumeric, QueryType } from './enums';
import { Platform } from '../platforms';
import { JoinOptions } from './QueryBuilder';
import { ReferenceType } from '../entity';
import { LockMode } from '../unit-of-work';
import { MetadataStorage } from '../metadata';

export class QueryBuilderHelper {

  static readonly GROUP_OPERATORS = {
    $and: 'and',
    $or: 'or',
  };

  static readonly OPERATORS = {
    $eq: '=',
    $in: 'in',
    $nin: 'not in',
    $gt: '>',
    $gte: '>=',
    $lt: '<',
    $lte: '<=',
    $ne: '!=',
    $not: 'not',
    $like: 'like',
    $re: 'regexp',
  };

  constructor(private readonly entityName: string,
              private readonly alias: string,
              private readonly aliasMap: Dictionary<string>,
              private readonly metadata: MetadataStorage,
              private readonly knex: Knex,
              private readonly platform: Platform) { }

  mapper(field: string, type?: QueryType): string;
  mapper(field: string, type?: QueryType, value?: any, alias?: string): string;
  mapper(field: string, type = QueryType.SELECT, value?: any, alias?: string): string | Raw {
    const fields = Utils.splitPrimaryKeys(field);

    if (fields.length > 1) {
      return this.knex.raw('(' + fields.map(f => this.knex.ref(this.mapper(f, type, value, alias))).join(', ') + ')');
    }

    let ret = field;
    const customExpression = QueryBuilderHelper.isCustomExpression(field);

    // do not wrap custom expressions
    if (!customExpression) {
      ret = this.prefix(field);
    }

    if (alias) {
      ret += ' as ' + alias;
    }

    if (customExpression) {
      return this.knex.raw(ret, value);
    }

    if (![QueryType.SELECT, QueryType.COUNT].includes(type) || this.isPrefixed(ret)) {
      return ret;
    }

    return this.alias + '.' + ret;
  }

  processData(data: Dictionary): any {
    data = Object.assign({}, data); // copy first
    const meta = this.metadata.get(this.entityName, false, false);

    Object.keys(data).forEach(k => {
      if (meta && meta.properties[k]) {
        const prop = meta.properties[k];

        if (prop.joinColumns && Array.isArray(data[k])) {
          const copy = data[k];
          delete data[k];
          prop.joinColumns.forEach((joinColumn, idx) => data[joinColumn] = copy[idx]);

          return;
        }

        if (!prop.customType && (Array.isArray(data[k]) || Utils.isObject(data[k], [Date]))) {
          data[k] = JSON.stringify(data[k]);
        }

        if (prop.fieldNames) {
          Utils.renameKey(data, k, prop.fieldNames[0]);
        }
      }
    });

    return data;
  }

  joinOneToReference(prop: EntityProperty, ownerAlias: string, alias: string, type: 'leftJoin' | 'innerJoin' | 'pivotJoin', cond: Dictionary = {}): JoinOptions {
    const meta = this.metadata.get(prop.type);
    const prop2 = meta.properties[prop.mappedBy || prop.inversedBy];

    return {
      prop, type, cond, ownerAlias, alias,
      table: this.getTableName(prop.type),
      joinColumns: prop.owner ? meta.primaryKeys : prop2.joinColumns,
      inverseJoinColumns: prop.owner ? meta.primaryKeys : prop.referencedColumnNames,
      primaryKeys: prop.owner ? prop.joinColumns : prop2.referencedColumnNames,
    };
  }

  joinManyToOneReference(prop: EntityProperty, ownerAlias: string, alias: string, type: 'leftJoin' | 'innerJoin' | 'pivotJoin', cond: Dictionary = {}): JoinOptions {
    return {
      prop, type, cond, ownerAlias, alias,
      table: this.getTableName(prop.type),
      joinColumns: prop.referencedColumnNames,
      primaryKeys: prop.fieldNames,
    };
  }

  joinManyToManyReference(prop: EntityProperty, ownerAlias: string, alias: string, pivotAlias: string, type: 'leftJoin' | 'innerJoin' | 'pivotJoin', cond: Dictionary): Dictionary<JoinOptions> {
    const join = {
      prop, type, cond, ownerAlias,
      alias: pivotAlias,
      inverseAlias: alias,
      joinColumns: prop.joinColumns,
      inverseJoinColumns: prop.inverseJoinColumns,
      primaryKeys: prop.referencedColumnNames,
    } as JoinOptions;
    const name = `${ownerAlias}.${prop.name}`;
    const ret: Dictionary<JoinOptions> = {};

    if (prop.owner) {
      ret[name] = Object.assign(join, { table: prop.pivotTable });
    } else {
      const meta = this.metadata.get(prop.type);
      const prop2 = meta.properties[prop.mappedBy];
      ret[name] = Object.assign(join, { table: prop2.pivotTable });
    }

    if (type === 'pivotJoin') {
      return ret;
    }

    const prop2 = this.metadata.get(prop.pivotTable).properties[prop.type + (prop.owner ? '_inverse' : '_owner')];
    ret[`${pivotAlias}.${prop2.name}`] = this.joinManyToOneReference(prop2, pivotAlias, alias, type);

    return ret;
  }

  joinPivotTable(field: string, prop: EntityProperty, ownerAlias: string, alias: string, type: 'leftJoin' | 'innerJoin' | 'pivotJoin', cond: Dictionary = {}): JoinOptions {
    const prop2 = this.metadata.get(field).properties[prop.mappedBy || prop.inversedBy];

    return {
      prop, type, cond, ownerAlias, alias,
      table: this.metadata.get(field).collection,
      joinColumns: prop.joinColumns,
      inverseJoinColumns: prop2.joinColumns,
      primaryKeys: prop.referencedColumnNames,
    };
  }

  processJoins(qb: KnexQueryBuilder, joins: Dictionary<JoinOptions>): void {
    Object.values(joins).forEach(join => {
      const table = `${join.table} as ${join.alias}`;
      const method = join.type === 'pivotJoin' ? 'leftJoin' : join.type;

      return qb[method](table, inner => {
        join.primaryKeys!.forEach((primaryKey, idx) => {
          const left = `${join.ownerAlias}.${primaryKey}`;
          const right = `${join.alias}.${join.joinColumns![idx]}`;
          inner.on(left, right);
        });
        this.appendJoinClause(inner, join.cond);
      });
    });
  }

  mapJoinColumns(type: QueryType, join: JoinOptions): (string | Raw)[] {
    if (join.prop && join.prop.reference === ReferenceType.ONE_TO_ONE && !join.prop.owner) {
      return join.prop.fieldNames.map((fieldName, idx) => {
        return this.mapper(`${join.alias}.${join.inverseJoinColumns![idx]}`, type, undefined, fieldName);
      });
    }

    return [
      ...join.joinColumns!.map(col => this.mapper(`${join.alias}.${col}`, type)),
      ...join.inverseJoinColumns!.map(col => this.mapper(`${join.alias}.${col}`, type)),
    ];
  }

  isOneToOneInverse(field: string): boolean {
    const meta = this.metadata.get(this.entityName);
    const prop = meta && meta.properties[field];

    return prop && prop.reference === ReferenceType.ONE_TO_ONE && !prop.owner;
  }

  getTableName(entityName: string): string {
    const meta = this.metadata.get(entityName, false, false);
    return meta ? meta.collection : entityName;
  }

  /**
   * Checks whether the RE can be rewritten to simple LIKE query
   */
  isSimpleRegExp(re: any): boolean {
    if (!(re instanceof RegExp)) {
      return false;
    }

    // when including the opening bracket/paren we consider it complex
    return !re.source.match(/[{[(]/);
  }

  getRegExpParam(re: RegExp): string {
    const value = re.source
      .replace(/\.\*/g, '%') // .* -> %
      .replace(/\./g, '_')   // .  -> _
      .replace(/\\_/g, '.')  // \. -> .
      .replace(/^\^/g, '')   // remove ^ from start
      .replace(/\$$/g, '');  // remove $ from end

    if (re.source.startsWith('^') && re.source.endsWith('$')) {
      return value;
    }

    if (re.source.startsWith('^')) {
      return value + '%';
    }

    if (re.source.endsWith('$')) {
      return '%' + value;
    }

    return `%${value}%`;
  }

  appendQueryCondition(type: QueryType, cond: any, qb: KnexQueryBuilder, operator?: '$and' | '$or', method: 'where' | 'having' = 'where'): void {
    Object.keys(cond).forEach(k => {
      if (k === '$and' || k === '$or') {
        if (operator === '$or' && k === '$and') {
          return qb.orWhere(inner => this.appendGroupCondition(type, inner, k, method, cond[k]));
        }

        return this.appendGroupCondition(type, qb, k, method, cond[k]);
      }

      if (k === '$not') {
        const m = operator === '$or' ? 'orWhereNot' : 'whereNot';
        return qb[m](inner => this.appendQueryCondition(type, cond[k], inner));
      }

      this.appendQuerySubCondition(qb, type, method, cond, k, operator);
    });
  }

  private appendQuerySubCondition(qb: KnexQueryBuilder, type: QueryType, method: 'where' | 'having', cond: any, key: string, operator?: '$and' | '$or'): void {
    const m = operator === '$or' ? 'orWhere' : method;

    if (this.isSimpleRegExp(cond[key])) {
      return void qb[m](this.mapper(key, type), 'like', this.getRegExpParam(cond[key]));
    }

    if (Utils.isObject(cond[key]) && !(cond[key] instanceof Date)) {
      return this.processObjectSubCondition(cond, key, qb, method, m, type);
    }

    if (QueryBuilderHelper.isCustomExpression(key)) {
      return this.processCustomExpression(qb, m, key, cond, type);
    }

    const op = cond[key] === null ? 'is' : '=';

    qb[m](this.mapper(key, type, cond[key]), op, cond[key]);
  }

  private processCustomExpression<T extends any[] = any[]>(clause: any, m: string, key: string, cond: any, type = QueryType.SELECT): void {
    // unwind parameters when ? found in field name
    const count = key.concat('?').match(/\?/g)!.length - 1;
    const value = Utils.asArray(cond[key]);
    const params1 = value.slice(0, count).map((c: any) => Utils.isObject(c) ? JSON.stringify(c) : c);
    const params2 = value.slice(count);
    const k = this.mapper(key, type, params1);

    if (params2.length > 0) {
      return void clause[m](k, this.knex.raw('?', params2));
    }

    clause[m](k);
  }

  private processObjectSubCondition(cond: any, key: string, qb: KnexQueryBuilder, method: 'where' | 'having', m: 'where' | 'orWhere' | 'having', type: QueryType): void {
    // grouped condition for one field
    let value = cond[key];

    if (Object.keys(value).length > 1) {
      const subCondition = Object.entries(value).map(([subKey, subValue]) => ({ [key]: { [subKey]: subValue } }));
      return void subCondition.forEach(sub => this.appendQueryCondition(type, sub, qb, '$and', method));
    }

    if (value instanceof RegExp) {
      value = { $re: value.source };
    }

    // operators
    const op = Object.keys(QueryBuilderHelper.OPERATORS).find(op => op in value);

    if (!op) {
      throw new Error(`Invalid query condition: ${inspect(cond)}`);
    }

    const replacement = this.getOperatorReplacement(op, value);
    const fields = Utils.splitPrimaryKeys(key);

    if (key === op) { // substitute top level operators with PK
      const meta = this.metadata.get(this.entityName);
      key = meta.properties[meta.primaryKeys[0]].fieldNames[0];
    }

    if (fields.length > 1 && Array.isArray(value[op]) && !value[op].every((v: unknown) => Array.isArray(v))) {
      value[op] = this.knex.raw(`(${fields.map(() => '?').join(', ')})`, value[op]);
    }

    qb[m](this.mapper(key, type), replacement, value[op]);
  }

  private getOperatorReplacement(op: string, value: Dictionary): string {
    let replacement = QueryBuilderHelper.OPERATORS[op];

    if (value[op] === null && ['$eq', '$ne'].includes(op)) {
      replacement = op === '$eq' ? 'is' : 'is not';
    }

    if (op === '$re') {
      replacement = this.platform.getRegExpOperator();
    }

    return replacement;
  }

  private appendJoinClause(clause: JoinClause, cond: Dictionary, operator?: '$and' | '$or'): void {
    Object.keys(cond).forEach(k => {
      if (k === '$and' || k === '$or') {
        const method = operator === '$or' ? 'orOn' : 'andOn';
        const m = k === '$or' ? 'orOn' : 'andOn';
        return clause[method](outer => cond[k].forEach((sub: any) => {
          if (Object.keys(sub).length === 1) {
            return this.appendJoinClause(outer, sub, k);
          }

          outer[m](inner => this.appendJoinClause(inner, sub, '$and'));
        }));
      }

      this.appendJoinSubClause(clause, cond, k, operator);
    });
  }

  private appendJoinSubClause(clause: JoinClause, cond: any, key: string, operator?: '$and' | '$or'): void {
    const m = operator === '$or' ? 'orOn' : 'andOn';

    if (cond[key] instanceof RegExp) {
      return void clause[m](this.mapper(key), 'like', this.knex.raw('?', this.getRegExpParam(cond[key])));
    }

    if (Utils.isObject(cond[key]) && !(cond[key] instanceof Date)) {
      return this.processObjectSubClause(cond, key, clause, m);
    }

    if (QueryBuilderHelper.isCustomExpression(key)) {
      return this.processCustomExpression(clause, m, key, cond);
    }

    const op = cond[key] === null ? 'is' : '=';
    clause[m](this.knex.raw(`${this.knex.ref(this.mapper(key, QueryType.SELECT, cond[key]))} ${op} ?`, cond[key]));
  }

  private processObjectSubClause(cond: any, key: string, clause: JoinClause, m: 'andOn' | 'orOn'): void {
    // grouped condition for one field
    if (Object.keys(cond[key]).length > 1) {
      const subCondition = Object.entries(cond[key]).map(([subKey, subValue]) => ({ [key]: { [subKey]: subValue } }));
      return void clause[m](inner => subCondition.map(sub => this.appendJoinClause(inner, sub, '$and')));
    }

    // operators
    for (const [op, replacement] of Object.entries(QueryBuilderHelper.OPERATORS)) {
      if (!(op in cond[key])) {
        continue;
      }

      clause[m](this.mapper(key), replacement, this.knex.raw('?', cond[key][op]));

      break;
    }
  }

  getQueryOrder(type: QueryType, orderBy: FlatQueryOrderMap, populate: Dictionary<string>): { column: string; order: string }[] {
    const ret: { column: string; order: string }[] = [];

    Object.keys(orderBy).forEach(k => {
      // eslint-disable-next-line prefer-const
      let [alias, field] = this.splitField(k);
      alias = populate[alias] || alias;
      Utils.splitPrimaryKeys(field).forEach(f => {
        const direction = orderBy[k];
        const order = Utils.isNumber<QueryOrderNumeric>(direction) ? QueryOrderNumeric[direction] : direction;

        ret.push({ column: this.mapper(`${alias}.${f}`, type), order: order.toLowerCase() });
      });
    });

    return ret;
  }

  finalize(type: QueryType, qb: KnexQueryBuilder, meta?: EntityMetadata): void {
    const useReturningStatement = type === QueryType.INSERT && this.platform.usesReturningStatement() && meta && !meta.compositePK;

    if (useReturningStatement) {
      const returningProps = Object.values(meta!.properties).filter(prop => prop.primary || prop.default);
      qb.returning(Utils.flatten(returningProps.map(prop => prop.fieldNames)));
    }
  }

  splitField(field: string): [string, string] {
    const [a, b] = field.split('.');
    const fromAlias = b ? a : this.alias;
    const fromField = b || a;

    return [fromAlias, fromField];
  }

  getLockSQL(qb: KnexQueryBuilder, lockMode?: LockMode): void {
    if (lockMode === LockMode.PESSIMISTIC_READ) {
      return void qb.forShare();
    }

    if (lockMode === LockMode.PESSIMISTIC_WRITE) {
      return void qb.forUpdate();
    }

    const meta = this.metadata.get(this.entityName, false, false);

    if (lockMode === LockMode.OPTIMISTIC && meta && !meta.versionProperty) {
      throw ValidationError.lockFailed(this.entityName);
    }
  }

  updateVersionProperty(qb: KnexQueryBuilder): void {
    const meta = this.metadata.get(this.entityName, false, false);

    if (!meta || !meta.versionProperty) {
      return;
    }

    const versionProperty = meta.properties[meta.versionProperty];
    let sql = versionProperty.fieldNames[0] + ' + 1';

    if (versionProperty.type.toLowerCase() === 'date') {
      sql = this.platform.getCurrentTimestampSQL(versionProperty.length);
    }

    qb.update(versionProperty.fieldNames[0], this.knex.raw(sql));
  }

  static isOperator(key: string, includeGroupOperators = true): boolean {
    if (!includeGroupOperators) {
      return !!QueryBuilderHelper.OPERATORS[key];
    }

    return !!QueryBuilderHelper.GROUP_OPERATORS[key] || !!QueryBuilderHelper.OPERATORS[key];
  }

  static isCustomExpression(field: string): boolean {
    return !!field.match(/[ ?<>=()]|^\d/);
  }

  private prefix(field: string): string {
    if (!this.isPrefixed(field)) {
      return this.fieldName(field, this.alias);
    }

    const [a, f] = field.split('.');

    return a + '.' + this.fieldName(f, a);
  }

  private appendGroupCondition(type: QueryType, qb: KnexQueryBuilder, operator: '$and' | '$or', method: 'where' | 'having', subCondition: any[]): void {
    if (subCondition.length === 1) {
      return this.appendQueryCondition(type, subCondition[0], qb, operator, method);
    }

    if (operator === '$and') {
      return subCondition.forEach(sub => this.appendQueryCondition(type, sub, qb, operator));
    }

    qb[method](outer => subCondition.forEach(sub => {
      if (Object.keys(sub).length === 1) {
        return this.appendQueryCondition(type, sub, outer, operator);
      }

      outer.orWhere(inner => this.appendQueryCondition(type, sub, inner, '$and'));
    }));
  }

  private isPrefixed(field: string): boolean {
    return !!field.match(/\w+\./);
  }

  private fieldName(field: string, alias?: string): string {
    const entityName = this.aliasMap[alias!] || this.entityName;
    const meta = this.metadata.get(entityName, false, false);
    const prop = meta ? meta.properties[field] : false;

    return prop ? prop.fieldNames[0] : field;
  }

}
