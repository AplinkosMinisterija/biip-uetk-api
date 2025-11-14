exports.up = async function (knex) {
  await knex.schema.alterTable('forms', (table) => {
    table.integer('assigneeId').unsigned();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('forms', (table) => {
    table.dropColumn('assigneeId');
  });
};
