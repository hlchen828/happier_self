-- AlterTable
ALTER TABLE `Account` ADD COLUMN `managedRole` VARCHAR(191) NOT NULL DEFAULT 'unmanaged';

-- AlterTable
ALTER TABLE `Session` ADD COLUMN `machineId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `Machine` ADD COLUMN `managedIdentityAccountId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `MachineGrant` (
    `machineId` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `dataEncryptionKey` LONGBLOB NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `MachineGrant_accountId_idx`(`accountId`),
    PRIMARY KEY (`machineId`, `accountId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ManagedAccountInvite` (
    `id` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NULL,
    `createdByAccountId` VARCHAR(191) NOT NULL,
    `consumedByAccountId` VARCHAR(191) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `revokedAt` DATETIME(3) NULL,
    `consumedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ManagedAccountInvite_tokenHash_key`(`tokenHash`),
    INDEX `ManagedAccountInvite_createdByAccountId_createdAt_idx`(`createdByAccountId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Session_machineId_idx` ON `Session`(`machineId`);

-- CreateIndex
CREATE UNIQUE INDEX `Machine_managedIdentityAccountId_key` ON `Machine`(`managedIdentityAccountId`);

-- AddForeignKey
ALTER TABLE `Session` ADD CONSTRAINT `Session_machineId_fkey` FOREIGN KEY (`machineId`) REFERENCES `Machine`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Machine` ADD CONSTRAINT `Machine_managedIdentityAccountId_fkey` FOREIGN KEY (`managedIdentityAccountId`) REFERENCES `Account`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MachineGrant` ADD CONSTRAINT `MachineGrant_machineId_fkey` FOREIGN KEY (`machineId`) REFERENCES `Machine`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MachineGrant` ADD CONSTRAINT `MachineGrant_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ManagedAccountInvite` ADD CONSTRAINT `ManagedAccountInvite_createdByAccountId_fkey` FOREIGN KEY (`createdByAccountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ManagedAccountInvite` ADD CONSTRAINT `ManagedAccountInvite_consumedByAccountId_fkey` FOREIGN KEY (`consumedByAccountId`) REFERENCES `Account`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

