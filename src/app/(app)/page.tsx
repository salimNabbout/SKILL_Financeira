// Placeholder — substituído pela implementação completa do dashboard.
import { PageHeader } from "@/components/ui";
import { requireSession } from "@/lib/session";

export default async function DashboardPage() {
  await requireSession();
  return (
    <div>
      <PageHeader title="Dashboard executivo" subtitle="Em construção" />
    </div>
  );
}
