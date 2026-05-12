/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function (knex) {
  return knex.schema
    .alterTable('forms', (table) => {
      table.text('generatedFile');
    })
    .raw(`ALTER TYPE form_history_type ADD VALUE IF NOT EXISTS 'FILE_GENERATED'`);
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function (knex) {
  return knex.schema.alterTable('forms', (table) => {
    table.dropColumn('generatedFile');
  });
};
