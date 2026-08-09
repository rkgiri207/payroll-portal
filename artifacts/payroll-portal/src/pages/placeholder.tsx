import * as React from "react"
import { Building2, UploadCloud, Trash2, LayoutTemplate } from "lucide-react"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export default function PlaceholderPage({ title, description }: { title: string, description: string }) {
  return (
    <div className="space-y-8 h-[calc(100vh-8rem)] flex flex-col" data-testid="page-placeholder">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        <p className="text-muted-foreground mt-1">
          {description}
        </p>
      </div>

      <Card className="flex-1 flex flex-col items-center justify-center border-dashed">
        <CardContent className="flex flex-col items-center text-center p-12">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted mb-6">
            <LayoutTemplate className="h-8 w-8 text-muted-foreground" />
          </div>
          <h2 className="text-2xl font-bold tracking-tight">Coming Soon</h2>
          <p className="text-muted-foreground max-w-md mt-2">
            This module is scheduled for a future stage of the Payroll Portal deployment. 
            Check the roadmap for release details.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
