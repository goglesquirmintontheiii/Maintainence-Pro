// "Message" on a person's page and a team page (r655): opens the direct conversation or the team chat.
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { MessageSquare } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useToast } from "../../components/Toast";
import { Button } from "../../components/ui";

export function MessageButton({ userId, teamId, label = "Message" }: { userId?: string; teamId?: string; label?: string }) {
  const { can, session } = useSession();
  const nav = useNavigate();
  const { toast } = useToast();
  const open = useMutation({
    mutationFn: () => teamId
      ? api<{ id: string }>(`/teams/${teamId}/conversation`, { method: "POST" })
      : api<{ id: string }>("/conversations", { method: "POST", body: { kind: "direct", user_id: userId } }),
    onSuccess: (c) => nav(`/messages/${c.id}`),
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  if (!can("messages.use") || (userId && userId === session.user?.id)) return null;
  return <Button onClick={() => open.mutate()} disabled={open.isPending}><MessageSquare size={16} />{label}</Button>;
}
