-- CreateTable
CREATE TABLE "my_task_activities" (
    "id" SERIAL NOT NULL,
    "task_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "action" VARCHAR(255) NOT NULL,
    "details" JSONB DEFAULT '{}',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "my_task_activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "my_task_activities_task_id_idx" ON "my_task_activities"("task_id");

-- AddForeignKey
ALTER TABLE "my_task_activities" ADD CONSTRAINT "my_task_activities_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "my_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "my_task_activities" ADD CONSTRAINT "my_task_activities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
