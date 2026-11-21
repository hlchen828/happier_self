-- MySQL 8 expression defaults permit an unbounded JSON string rather than VARCHAR(191).
ALTER TABLE `ManagedAccountInvite` ADD COLUMN `machineIds` LONGTEXT NOT NULL DEFAULT ('[]');
