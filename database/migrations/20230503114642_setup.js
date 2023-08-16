const commonFields = (table) => {
  table.timestamp('createdAt');
  table.integer('createdBy').unsigned();
  table.timestamp('updatedAt');
  table.integer('updatedBy').unsigned();
  table.timestamp('deletedAt');
  table.integer('deletedBy').unsigned();
};

exports.commonFields = commonFields;

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function (knex) {
  return knex.schema
    .createTable('users', (table) => {
      table.increments('id');
      table.integer('authUserId').unsigned();
      table.string('firstName', 255);
      table.string('lastName', 255);
      table.string('email', 255);
      table.string('phone', 255);
      table
        .enu('type', ['USER', 'ADMIN'], {
          useNative: true,
          enumName: 'user_type',
        })
        .defaultTo('USER');
      commonFields(table);
    })
    .createTable('tenants', (table) => {
      table.increments('id');
      table.string('name', 255);
      table.integer('authGroupId').unsigned();
      table.string('phone', 255);
      table.string('email', 255);
      table.string('code', 255);
      commonFields(table);
    })
    .createTable('tenantUsers', (table) => {
      table.increments('id');
      table.integer('tenantId').unsigned();
      table.integer('userId').unsigned();
      table
        .enu('role', ['USER', 'ADMIN'], {
          useNative: true,
          enumName: 'tenant_user_role',
        })
        .defaultTo('USER');
      commonFields(table);
    });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function (knex) {
  return knex.schema
    .dropTable('users')
    .dropTable('tenants')
    .dropTable('tenantUsers');
};
