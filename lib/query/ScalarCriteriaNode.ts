import { MetadataStorage } from '../metadata';
import { QueryBuilder } from './QueryBuilder';
import { ReferenceType } from '../entity';
import { CriteriaNode } from './internal';

export class ScalarCriteriaNode extends CriteriaNode {

  static create(metadata: MetadataStorage, entityName: string, payload: any, parent?: CriteriaNode, key?: string): ScalarCriteriaNode {
    const node = new ScalarCriteriaNode(metadata, entityName, parent, key);
    node.payload = payload;

    return node;
  }

  process(qb: QueryBuilder, alias?: string): any {
    if (this.shouldJoin()) {
      const nestedAlias = qb.getAliasForEntity(this.entityName, this) || qb.getNextAlias();
      const field = `${alias}.${this.prop!.name}`;

      if (this.prop!.reference === ReferenceType.MANY_TO_MANY) {
        qb.join(field, nestedAlias, undefined, 'pivotJoin', this.getPath());
      } else {
        qb.join(field, nestedAlias, undefined, 'leftJoin', this.getPath());
      }

      if (this.prop!.reference === ReferenceType.ONE_TO_ONE) {
        qb.addSelect(field);
      }
    }

    return this.payload;
  }

  shouldJoin(): boolean {
    if (!this.parent || !this.prop || [ReferenceType.SCALAR, ReferenceType.ONE_TO_MANY].includes(this.prop.reference)) {
      return false;
    }

    if (this.prop.reference === ReferenceType.ONE_TO_ONE) {
      return !this.prop.owner;
    }

    return this.prop.reference === ReferenceType.MANY_TO_MANY;
  }

}
