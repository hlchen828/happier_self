-- Persist the complete invitation intent independently of the Machine lifecycle.
ALTER TABLE "ManagedAccountInvite" ADD COLUMN "machineIds" TEXT NOT NULL DEFAULT '[]';
