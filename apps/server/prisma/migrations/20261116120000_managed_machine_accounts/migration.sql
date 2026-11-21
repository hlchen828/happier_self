-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "managedRole" TEXT NOT NULL DEFAULT 'unmanaged';

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "machineId" TEXT;

-- AlterTable
ALTER TABLE "Machine" ADD COLUMN     "managedIdentityAccountId" TEXT;

-- CreateTable
CREATE TABLE "MachineGrant" (
    "machineId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "dataEncryptionKey" BYTEA,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MachineGrant_pkey" PRIMARY KEY ("machineId","accountId")
);

-- CreateTable
CREATE TABLE "ManagedAccountInvite" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT,
    "createdByAccountId" TEXT NOT NULL,
    "consumedByAccountId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManagedAccountInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MachineGrant_accountId_idx" ON "MachineGrant"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "ManagedAccountInvite_tokenHash_key" ON "ManagedAccountInvite"("tokenHash");

-- CreateIndex
CREATE INDEX "ManagedAccountInvite_createdByAccountId_createdAt_idx" ON "ManagedAccountInvite"("createdByAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "Session_machineId_idx" ON "Session"("machineId");

-- CreateIndex
CREATE UNIQUE INDEX "Machine_managedIdentityAccountId_key" ON "Machine"("managedIdentityAccountId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Machine" ADD CONSTRAINT "Machine_managedIdentityAccountId_fkey" FOREIGN KEY ("managedIdentityAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineGrant" ADD CONSTRAINT "MachineGrant_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineGrant" ADD CONSTRAINT "MachineGrant_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagedAccountInvite" ADD CONSTRAINT "ManagedAccountInvite_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagedAccountInvite" ADD CONSTRAINT "ManagedAccountInvite_consumedByAccountId_fkey" FOREIGN KEY ("consumedByAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
