import { toast } from "@/components/ui/use-toast";

export function notifyInfo(title, description) {
  toast({ title, description, variant: "info" });
}

export function notifySuccess(title, description) {
  toast({ title, description, variant: "success" });
}

export function notifyWarning(title, description) {
  toast({ title, description, variant: "warning" });
}

export function notifyError(title, description) {
  toast({ title, description, variant: "destructive" });
}
