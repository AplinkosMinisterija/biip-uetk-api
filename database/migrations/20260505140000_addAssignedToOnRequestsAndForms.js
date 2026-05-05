/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function (knex) {
  return knex.schema
    .alterTable('requests', (table) => {
      table.integer('assignedTo').unsigned();
    })
    .alterTable('forms', (table) => {
      table.integer('assignedTo').unsigned();
    });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function (knex) {
  return knex.schema
    .alterTable('requests', (table) => {
      table.dropColumn('assignedTo');
    })
    .alterTable('forms', (table) => {
      table.dropColumn('assignedTo');
    });
};
