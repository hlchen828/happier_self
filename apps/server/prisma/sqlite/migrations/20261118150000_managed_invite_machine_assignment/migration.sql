-- Existing invitation rows retain their no-selection behavior.
ALTER TABLE "ManagedAccountInvite" ADD COLUMN "machineIds" TEXT NOT NULL DEFAULT '[]';
