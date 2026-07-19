import {pgTableCreator} from 'drizzle-orm/pg-core';

export const authTable = pgTableCreator((name) => `auth_${name}`);
export const accountsTable = pgTableCreator((name) =>
  name === 'accounts' ? name : `accounts_${name}`,
);
