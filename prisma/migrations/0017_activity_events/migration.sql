-- CreateTable
CREATE TABLE "ActivityEvent" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT,
    "origin" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "screen" TEXT,
    "method" TEXT,
    "path" TEXT,
    "status" INTEGER,
    "durationMs" INTEGER,
    "ip" TEXT,
    "userAgent" TEXT,
    "label" TEXT,
    "elementId" TEXT,
    "detailsJson" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActivityEvent_companyId_timestamp_idx" ON "ActivityEvent"("companyId", "timestamp");

-- CreateIndex
CREATE INDEX "ActivityEvent_companyId_userId_idx" ON "ActivityEvent"("companyId", "userId");

-- CreateIndex
CREATE INDEX "ActivityEvent_companyId_eventType_idx" ON "ActivityEvent"("companyId", "eventType");

-- AddForeignKey
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

