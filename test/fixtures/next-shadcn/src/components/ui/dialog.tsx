"use client"

import { Dialog as DialogPrimitive } from "@base-ui-components/react/dialog"

function Dialog(props: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogContent({ className, ...props }: DialogPrimitive.Popup.Props) {
  return <DialogPrimitive.Popup className="bg-background rounded-lg border p-6" {...props} />
}

export { Dialog, DialogContent }
