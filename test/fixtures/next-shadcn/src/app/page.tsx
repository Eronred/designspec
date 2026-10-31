import { Dialog } from "@base-ui-components/react/dialog"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

export default function Page({ danger }: { danger: boolean }) {
  return (
    <main className="flex flex-col gap-4 p-6">
      <h1 className="text-[#1a1a1a] text-2xl">Settings</h1>
      <div className={cn("rounded-lg border p-[13px]", danger && "bg-red-500 text-white")}>
        <Input placeholder="Name" />
        <input type="email" placeholder="Email" />
        <input type="checkbox" />
      </div>
      <button onClick={() => {}}>Save</button>
      <Button variant="ghost2">Cancel</Button>
      <Button variant="outline" size="sm">Back</Button>
      <a className={buttonVariants({ variant: "link", size: "xl" })} href="/">Home</a>
      <p style={{ color: "#e5484d", padding: 8 }}>Something went wrong</p>
      {/* designspec-ignore-next-line no-hardcoded-color: partner brand color */}
      <span className="bg-[#ff6600]">Partner</span>
      <svg><path fill="#000000" /></svg>
      <Dialog.Root />
      <Button size="sm" className="h-12 w-full rounded-none">Wide</Button>
    </main>
  )
}
