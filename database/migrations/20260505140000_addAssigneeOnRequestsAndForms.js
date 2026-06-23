/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function (knex) {
  return knex.schema
    .alterTable('requests', (table) => {
      table.integer('assigneeId').unsigned();
    })
    .alterTable('forms', (table) => {
      table.integer('assigneeId').unsigned();
    });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function (knex) {
  return knex.schema
    .alterTable('requests', (table) => {
      table.dropColumn('assigneeId');
    })
    .alterTable('forms', (table) => {
      table.dropColumn('assigneeId');
    });
};
