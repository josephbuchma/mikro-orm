import { inspect } from 'util';
import { EntityProperty } from '../typings';
import { MetadataStorage } from '../metadata';
import { QueryBuilderHelper } from './QueryBuilderHelper';
import { Utils } from '../utils';
import { QueryBuilder } from './QueryBuilder';
import { ReferenceType } from '../entity';
import { ObjectCriteriaNode, ScalarCriteriaNode, ArrayCriteriaNode } from './internal';

/**
 * Helper for working with deeply nested where/orderBy/having criteria. Uses composite pattern to build tree from the payload.
 * Auto-joins relations and converts payload from { books: { publisher: { name: '...' } } } to { 'publisher_alias.name': '...' }
 */
export class CriteriaNode {

  payload: any;
  prop?: EntityProperty;

  constructor(protected readonly metadata: MetadataStorage,
              readonly entityName: string,
              readonly parent?: CriteriaNode,
              readonly key?: string,
              validate = true) {
    const meta = parent && metadata.get(parent.entityName, false, false);

    if (meta && key) {
      Utils.splitPrimaryKeys(key).forEach(k => {
        this.prop = meta.properties[k];

        if (validate && !this.prop && !k.includes('.') && !QueryBuilderHelper.isOperator(k) && !QueryBuilderHelper.isCustomExpression(k)) {
          throw new Error(`Trying to query by not existing property ${entityName}.${k}`);
        }
      });
    }
  }

  static create(metadata: MetadataStorage, entityName: string, payload: any, parent?: CriteriaNode, key?: string): CriteriaNode {
    const customExpression = QueryBuilderHelper.isCustomExpression(key || '');
    const scalar = Utils.isPrimaryKey(payload) || payload instanceof RegExp || payload instanceof Date || customExpression;

    if (Array.isArray(payload) && !scalar) {
      return ArrayCriteriaNode.create(metadata, entityName, payload, parent, key);
    }

    if (Utils.isObject(payload) && !scalar) {
      return ObjectCriteriaNode.create(metadata, entityName, payload, parent, key);
    }

    return ScalarCriteriaNode.create(metadata, entityName, payload, parent, key);
  }

  process(qb: QueryBuilder, alias?: string): any {
    return this.payload;
  }

  shouldInline(payload: any): boolean {
    return false;
  }

  shouldRename(payload: any): boolean {
    const type = this.prop ? this.prop.reference : null;
    const composite = this.prop && this.prop.joinColumns ? this.prop.joinColumns.length > 1 : false;
    const customExpression = QueryBuilderHelper.isCustomExpression(this.key!);
    const scalar = Utils.isPrimaryKey(payload) || payload instanceof RegExp || payload instanceof Date || customExpression;
    const operator = Utils.isObject(payload) && Object.keys(payload).every(k => QueryBuilderHelper.isOperator(k, false));

    if (composite) {
      return true;
    }

    switch (type) {
      case ReferenceType.MANY_TO_ONE: return false;
      case ReferenceType.ONE_TO_ONE: return !this.prop!.owner && !(this.parent && this.parent.parent);
      case ReferenceType.ONE_TO_MANY: return scalar || operator;
      case ReferenceType.MANY_TO_MANY: return scalar || operator;
      default: return false;
    }
  }

  renameFieldToPK(qb: QueryBuilder): string {
    if (this.prop!.reference === ReferenceType.MANY_TO_MANY) {
      const pivotTable = this.prop!.pivotTable;
      const alias = qb.getAliasForEntity(pivotTable, this);

      return Utils.getPrimaryKeyHash(this.prop!.inverseJoinColumns.map(col => `${alias}.${col}`));
    }

    if (this.prop!.joinColumns.length > 1) {
      return Utils.getPrimaryKeyHash(this.prop!.joinColumns);
    }

    const meta = this.metadata.get(this.prop!.type);
    const alias = qb.getAliasForEntity(meta.name, this);
    const pks = Utils.flatten(meta.primaryKeys.map(primaryKey => meta.properties[primaryKey].fieldNames));

    return Utils.getPrimaryKeyHash(pks.map(col => `${alias}.${col}`));
  }

  getPath(): string {
    let ret = this.parent && this.prop ? this.prop.name : this.entityName;

    if (this.parent instanceof ArrayCriteriaNode && this.parent.parent && !this.key) {
      ret = this.parent.parent.key!;
    }

    if (this.parent) {
      const parentPath = this.parent.getPath();

      if (parentPath) {
        ret = this.parent.getPath() + '.' + ret;
      } else if (this.parent.entityName && ret) {
        ret = this.parent.entityName + '.' + ret;
      }
    }

    return ret;
  }

  [inspect.custom]() {
    return `${this.constructor.name} ${inspect({ entityName: this.entityName, key: this.key, payload: this.payload })}`;
  }

}
