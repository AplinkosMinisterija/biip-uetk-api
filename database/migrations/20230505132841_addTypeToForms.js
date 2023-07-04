const { commonFields } = require('./20230503114642_setup');

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function (knex) {
  return knex.schema.alterTable('forms', (table) => {
    table
      .enu('type', ['NEW', 'EDIT', 'REMOVE'], {
        useNative: true,
        enumName: 'form_type',
      })
      .defaultTo('NEW');
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function (knex) {
  return knex.schema.alterTable('forms', (table) => {
    table.dropColumn('type');
  });
};
