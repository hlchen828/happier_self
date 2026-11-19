-- Use additive columns rather than Prisma's table rebuild: Session.needsAttention
-- is a database-generated column whose expression must survive unchanged.
ALTER TABLE "Account" ADD COLUMN "managedRole" TEXT NOT NULL DEFAULT 'unmanaged';
ALTER TABLE "Session" ADD COLUMN "machineId" TEXT REFERENCES "Machine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Machine" ADD COLUMN "managedIdentityAccountId" TEXT REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "MachineGrant" (
    "machineId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "dataEncryptionKey" BLOB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    PRIMARY KEY ("machineId", "accountId"),
    CONSTRAINT "MachineGrant_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MachineGrant_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "ManagedAccountInvite" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT,
    "createdByAccountId" TEXT NOT NULL,
    "consumedByAccountId" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "consumedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ManagedAccountInvite_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ManagedAccountInvite_consumedByAccountId_fkey" FOREIGN KEY ("consumedByAccountId") REFERENCES "Account" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "MachineGrant_accountId_idx" ON "MachineGrant"("accountId");
CREATE UNIQUE INDEX "ManagedAccountInvite_tokenHash_key" ON "ManagedAccountInvite"("tokenHash");
CREATE INDEX "ManagedAccountInvite_createdByAccountId_createdAt_idx" ON "ManagedAccountInvite"("createdByAccountId", "createdAt");
CREATE INDEX "Session_machineId_idx" ON "Session"("machineId");
CREATE UNIQUE INDEX "Machine_managedIdentityAccountId_key" ON "Machine"("managedIdentityAccountId");
