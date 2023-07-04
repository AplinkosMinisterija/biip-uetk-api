const { commonFields } = require('./20230503114642_setup');

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function (knex) {
  return knex.schema
    .raw(`CREATE EXTENSION IF NOT EXISTS postgis;`)
    .createTable('forms', (table) => {
      table.increments('id');
      table.integer('tenantId').unsigned();
      table.string('objectType', 255);
      table.text('objectName');
      table.integer('cadastralId').unsigned();
      table.text('description');
      table
        .enu(
          'status',
          ['CREATED', 'RETURNED', 'REJECTED', 'APPROVED', 'SUBMITTED'],
          { useNative: true, enumName: 'form_status' }
        )
        .defaultTo('CREATED');
      table.jsonb('files');
      table.jsonb('data');
      table.string('providerType', 255);
      table.string('providedBy', 255);
      table.timestamp('respondedAt');

      commonFields(table);
    })
    .raw(`ALTER TABLE forms ADD COLUMN geom geometry(point, 3346)`)
    .createTable('formHistories', (table) => {
      table.increments('id');
      table.integer('formId').unsigned().notNullable();
      table.enu(
        'type',
        ['CREATED', 'UPDATED', 'REJECTED', 'RETURNED', 'APPROVED'],
        { useNative: true, enumName: 'form_history_type' }
      );
      table.text('comment');
      commonFields(table);
    })
    .raw(`CREATE INDEX forms_geom_idx ON forms USING GIST (geom)`);
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function (knex) {
  return knex.schema.dropTable('forms').dropTable('formHistories');
};
