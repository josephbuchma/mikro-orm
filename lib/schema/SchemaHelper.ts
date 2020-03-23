import { TableBuilder } from 'knex';
import { Dictionary, EntityProperty } from '../typings';
import { AbstractSqlConnection } from '../connections/AbstractSqlConnection';
import { Column, Index } from './DatabaseTable';
import { ReferenceType } from '../entity';
import { Utils } from '../utils';
import { Connection } from '../connections';

export abstract class SchemaHelper {

  getSchemaBeginning(): string {
    return '';
  }

  getSchemaEnd(): string {
    return '';
  }

  finalizeTable(table: TableBuilder): void {
    //
  }

  getTypeDefinition(prop: EntityProperty, types: Dictionary<string[]> = {}, lengths: Dictionary<number> = {}, allowZero = false): string {
    let t = prop.type.toLowerCase();

    if (prop.enum) {
      t = prop.items && prop.items.every(item => Utils.isString(item)) ? 'enum' : 'tinyint';
    }

    let type = (types[t] || types.json || types.text || [t])[0];

    if (type.includes('(?)')) {
      type = this.processTypeWildCard(prop, lengths, t, allowZero, type);
    }

    return type;
  }

  isSame(prop: EntityProperty, column: Column, idx = 0, types: Dictionary<string[]> = {}, defaultValues: Dictionary<string[]> = {}): IsSame {
    const sameTypes = this.hasSameType(prop.columnTypes[idx], column.type, types);
    const sameNullable = column.nullable === !!prop.nullable;
    const sameDefault = this.hasSameDefaultValue(column, prop, defaultValues);
    const sameIndex = this.hasSameIndex(prop, column);
    const all = sameTypes && sameNullable && sameDefault && sameIndex;

    return { all, sameTypes, sameNullable, sameDefault, sameIndex };
  }

  supportsSchemaConstraints(): boolean {
    return true;
  }

  indexForeignKeys() {
    return true;
  }

  getTypeFromDefinition(type: string, defaultType: string, types?: Dictionary<string[]>): string {
    type = type.replace(/\(.+\)/, '');

    const found = Object.entries(types!)
      .filter(([, tt]) => tt.find(ttt => ttt.replace(/\(.+\)/, '') === type))
      .map(([t]) => t)[0];

    return found || defaultType;
  }

  async getPrimaryKeys(connection: AbstractSqlConnection, indexes: Dictionary<Index[]>, tableName: string, schemaName?: string): Promise<string[]> {
    const ret = [];

    for (const idx of Object.values(indexes)) {
      const pks = idx.filter(i => i.primary).map(i => i.columnName);
      ret.push(...pks);
    }

    return ret;
  }

  async getForeignKeys(connection: AbstractSqlConnection, tableName: string, schemaName?: string): Promise<Dictionary> {
    const fks = await connection.execute<any[]>(this.getForeignKeysSQL(tableName, schemaName));
    return this.mapForeignKeys(fks);
  }

  getListTablesSQL(): string {
    throw new Error('Not supported by given driver');
  }

  getRenameColumnSQL(tableName: string, from: Column, to: EntityProperty, idx = 0, quote = '"'): string {
    return `alter table ${quote}${tableName}${quote} rename column ${quote}${from.name}${quote} to ${quote}${to.fieldNames[0]}${quote}`;
  }

  async getColumns(connection: AbstractSqlConnection, tableName: string, schemaName?: string): Promise<any[]> {
    throw new Error('Not supported by given driver');
  }

  async getIndexes(connection: AbstractSqlConnection, tableName: string, schemaName?: string): Promise<Dictionary<any[]>> {
    throw new Error('Not supported by given driver');
  }

  getForeignKeysSQL(tableName: string, schemaName?: string): string {
    throw new Error('Not supported by given driver');
  }

  mapForeignKeys(fks: any[]): Dictionary {
    return fks.reduce((ret, fk: any) => {
      ret[fk.column_name] = {
        columnName: fk.column_name,
        constraintName: fk.constraint_name,
        referencedTableName: fk.referenced_table_name,
        referencedColumnName: fk.referenced_column_name,
        updateRule: fk.update_rule,
        deleteRule: fk.delete_rule,
      };

      return ret;
    }, {});
  }

  private processTypeWildCard(prop: EntityProperty, lengths: Dictionary<number>, propType: string, allowZero: boolean, type: string): string {
    let length = prop.length || lengths[propType];

    if (allowZero) {
      length = '' + length;
    }

    type = length ? type.replace('?', length) : type.replace('(?)', '');

    return type;
  }

  supportsColumnAlter(): boolean {
    return true;
  }

  normalizeDefaultValue(defaultValue: string, length: number, defaultValues: Dictionary<string[]> = {}): string | number {
    const genericValue = defaultValue.replace(/\(\d+\)/, '(?)').toLowerCase();
    const norm = defaultValues[genericValue];

    if (!norm) {
      return defaultValue;
    }

    return norm[0].replace('(?)', `(${length})`);
  }

  getCreateDatabaseSQL(name: string): string {
    return `create database ${name}`;
  }

  getDropDatabaseSQL(name: string): string {
    return `drop database if exists ${name}`;
  }

  getDatabaseExistsSQL(name: string): string {
    return `select 1 from information_schema.schemata where schema_name = '${name}'`;
  }

  getDatabaseNotExistsError(dbName: string): string {
    return `Unknown database '${dbName}'`;
  }

  getManagementDbName(): string {
    return 'information_schema';
  }

  async databaseExists(connection: Connection, name: string): Promise<boolean> {
    try {
      const res = await connection.execute(this.getDatabaseExistsSQL(name));
      return res.length > 0;
    } catch (e) {
      if (e.message.includes(this.getDatabaseNotExistsError(name))) {
        return false;
      }

      throw e;
    }
  }

  private hasSameType(columnType: string, infoType: string, types: Dictionary<string[]>): boolean {
    columnType = columnType.replace(/\([?\d]+\)/, '').toLowerCase();
    infoType = infoType.replace(/\([?\d]+\)/, '').toLowerCase();

    if (columnType === infoType) {
      return true;
    }

    const type = Object.values(types).find(t => t.some(tt => tt.replace(/\([?\d]+\)/, '').toLowerCase() === infoType));

    if (!type) {
      return false;
    }

    const propTypes = type.map(t => t.replace(/\([?\d]+\)/, '').toLowerCase());

    return propTypes.includes(columnType);
  }

  private hasSameDefaultValue(info: Column, prop: EntityProperty, defaultValues: Dictionary<string[]>): boolean {
    if (info.defaultValue && prop.default) {
      const defaultValue = info.defaultValue.toString().replace(/\([?\d]+\)/, '').toLowerCase();
      const propDefault = prop.default.toString().toLowerCase();
      const same = propDefault === info.defaultValue.toString().toLowerCase();
      const equal = same || propDefault === defaultValue;

      return equal || Object.keys(defaultValues).map(t => t.replace(/\([?\d]+\)/, '').toLowerCase()).includes(defaultValue);
    }

    if (info.defaultValue === null || info.defaultValue.toString().startsWith('nextval(')) {
      return prop.default === undefined;
    }

    if (prop.type === 'boolean') {
      const defaultValue = !['0', 'false', 'f', 'n', 'no', 'off'].includes(info.defaultValue);
      return defaultValue === !!prop.default;
    }

    // eslint-disable-next-line eqeqeq
    return info.defaultValue == prop.default; // == intentionally
  }

  private hasSameIndex(prop: EntityProperty, column: Column): boolean {
    if (prop.reference === ReferenceType.SCALAR) {
      return true;
    }

    return prop.referencedColumnNames.some(referencedColumnName => {
      return !!column.fk && referencedColumnName === column.fk.referencedColumnName && prop.referencedTableName === column.fk.referencedTableName;
    });
  }

}

export interface IsSame {
  all?: boolean;
  sameTypes?: boolean;
  sameNullable?: boolean;
  sameDefault?: boolean;
  sameIndex?: boolean;
}
