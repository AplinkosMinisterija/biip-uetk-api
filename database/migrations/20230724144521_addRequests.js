const { commonFields } = require('./20230503114642_setup');

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function (knex) {
  return knex.schema
    .createTable('requests', (table) => {
      table.increments('id');
      table.integer('tenantId').unsigned();
      table
        .enu(
          'status',
          ['CREATED', 'RETURNED', 'REJECTED', 'APPROVED', 'SUBMITTED'],
          { useNative: true, enumName: 'request_status' }
        )
        .defaultTo('CREATED');
      table.jsonb('objects');
      table.string('purpose', 255);
      table.string('delivery', 255);
      table.string('notifyEmail', 255);
      table.string('generatedFile', 255);
      table.jsonb('data');
      table.timestamp('respondedAt');
      commonFields(table);
    })
    .raw(`ALTER TABLE requests ADD COLUMN geom geometry(multipolygon, 3346)`)
    .createTable('requestHistories', (table) => {
      table.increments('id');
      table.integer('requestId').unsigned().notNullable();
      table.enu(
        'type',
        ['CREATED', 'UPDATED', 'REJECTED', 'RETURNED', 'APPROVED'],
        { useNative: true, enumName: 'request_history_type' }
      );
      table.text('comment');
      commonFields(table);
    })
    .raw(`CREATE INDEX requests_geom_idx ON requests USING GIST (geom)`);
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function (knex) {
  return knex.schema.dropTable('requests').dropTable('requestHistories');
};
