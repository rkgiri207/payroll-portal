import * as React from "react"
import { z } from "zod"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Building2, UploadCloud, Trash2, Loader2, Image as ImageIcon } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"

import { 
  useGetCompanySettings, 
  useUpdateCompanySettings, 
  useRemoveCompanyLogo,
  useRequestUploadUrl,
  getGetCompanySettingsQueryKey
} from "@workspace/api-client-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { useToast } from "@/hooks/use-toast"

const identitySchema = z.object({
  companyName: z.string().min(1, "Company name is required"),
  address: z.string().max(1000, "Address is too long").optional(),
})
type IdentityFormValues = z.infer<typeof identitySchema>

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

export default function SettingsPage() {
  const { data: settings, isLoading } = useGetCompanySettings()
  
  if (isLoading) {
    return (
      <div className="space-y-8">
        <div>
          <Skeleton className="h-10 w-48 mb-2" />
          <Skeleton className="h-4 w-96" />
        </div>
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  return (
    <div className="space-y-8" data-testid="page-settings">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Administrative Settings</h1>
        <p className="text-muted-foreground mt-1">
          Manage organizational profile and system preferences.
        </p>
      </div>

      <div className="grid gap-8">
        <CompanyIdentitySection defaultName={settings?.companyName || ""} defaultAddress={settings?.address || ""} />
        <CompanyLogoSection logoPath={settings?.logoPath} />
      </div>
    </div>
  )
}

function CompanyIdentitySection({ defaultName, defaultAddress }: { defaultName: string; defaultAddress: string }) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  
  const updateSettings = useUpdateCompanySettings({
    mutation: {
      onSuccess: () => {
        toast({
          title: "Settings saved",
          description: "Organization details have been updated successfully.",
        })
        queryClient.invalidateQueries({ queryKey: getGetCompanySettingsQueryKey() })
      },
      onError: () => {
        toast({
          title: "Error",
          description: "Failed to update organization details.",
          variant: "destructive"
        })
      }
    }
  })

  const form = useForm<IdentityFormValues>({
    resolver: zodResolver(identitySchema),
    defaultValues: {
      companyName: defaultName,
      address: defaultAddress,
    },
  })

  // Reset form when defaultName changes (initial load)
  React.useEffect(() => {
    form.reset({ companyName: defaultName, address: defaultAddress })
  }, [defaultName, defaultAddress, form])

  const onSubmit = (data: IdentityFormValues) => {
    updateSettings.mutate({ data: { ...data, address: data.address?.trim() || null } })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Organization Identity</CardTitle>
        <CardDescription>
          The company name displayed across the portal and generated documents.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 max-w-xl">
          <div className="space-y-2">
            <Label htmlFor="companyName">Company Name</Label>
            <Input
              id="companyName"
              {...form.register("companyName")}
              data-testid="input-company-name"
            />
            {form.formState.errors.companyName && (
              <p className="text-sm font-medium text-destructive">
                {form.formState.errors.companyName.message}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="address">Address</Label>
            <Textarea
              id="address"
              rows={3}
              placeholder="Organization postal address"
              {...form.register("address")}
              data-testid="input-company-address"
            />
            {form.formState.errors.address && (
              <p className="text-sm font-medium text-destructive">{form.formState.errors.address.message}</p>
            )}
          </div>
          <Button 
            type="submit" 
            disabled={updateSettings.isPending || !form.formState.isDirty}
            data-testid="button-save-name"
          >
            {updateSettings.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Changes
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

function CompanyLogoSection({ logoPath }: { logoPath?: string | null }) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [isUploading, setIsUploading] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  const requestUrl = useRequestUploadUrl()
  const updateSettings = useUpdateCompanySettings()
  const removeLogo = useRemoveCompanyLogo({
    mutation: {
      onSuccess: () => {
        toast({ title: "Logo removed", description: "Company logo has been cleared." })
        queryClient.invalidateQueries({ queryKey: getGetCompanySettingsQueryKey() })
      },
      onError: () => {
        toast({ title: "Error", description: "Failed to remove logo.", variant: "destructive" })
      }
    }
  })

  const logoUrl = logoPath ? `/api/storage${logoPath}` : null

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    // Validation
    if (file.size > MAX_FILE_SIZE) {
      toast({ title: "File too large", description: "Logo must be under 5MB.", variant: "destructive" })
      return
    }
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      toast({ title: "Invalid format", description: "Only PNG, JPG, and WEBP formats are supported.", variant: "destructive" })
      return
    }

    setIsUploading(true)
    try {
      // 1. Get presigned URL
      const { uploadURL, objectPath } = await requestUrl.mutateAsync({
        data: { name: file.name, size: file.size, contentType: file.type }
      })

      // 2. Upload to GCS directly
      const uploadRes = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file
      })

      if (!uploadRes.ok) throw new Error("Upload failed")

      // 3. Save objectPath to settings
      await updateSettings.mutateAsync({
        data: { logoPath: objectPath }
      })

      toast({ title: "Upload successful", description: "Company logo has been updated." })
      queryClient.invalidateQueries({ queryKey: getGetCompanySettingsQueryKey() })
      
    } catch (err) {
      toast({ title: "Upload failed", description: "There was an error uploading your logo. Please try again.", variant: "destructive" })
    } finally {
      setIsUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  const handleRemove = () => {
    removeLogo.mutate()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Brand Logo</CardTitle>
        <CardDescription>
          Upload a high-resolution logo for headers and PDF reports (max 5MB).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col sm:flex-row gap-8 items-start">
          
          <div className="flex-shrink-0">
            <div className="h-32 w-32 rounded-lg border-2 border-dashed flex items-center justify-center bg-muted/50 overflow-hidden relative" data-testid="logo-preview-container">
              {logoUrl ? (
                <img src={logoUrl} alt="Company Logo" className="w-full h-full object-contain p-2" data-testid="img-logo" />
              ) : (
                <div className="flex flex-col items-center text-muted-foreground p-4 text-center">
                  <ImageIcon className="h-8 w-8 mb-2 opacity-50" />
                  <span className="text-xs font-medium">No logo set</span>
                </div>
              )}
              {isUploading && (
                <div className="absolute inset-0 bg-background/80 flex items-center justify-center backdrop-blur-sm">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              )}
            </div>
          </div>

          <div className="space-y-4 flex-1 max-w-sm">
            <div className="space-y-2">
              <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                accept={ACCEPTED_IMAGE_TYPES.join(",")}
                onChange={handleFileChange}
                disabled={isUploading}
                data-testid="input-logo-file"
              />
              <Button 
                variant="outline" 
                className="w-full"
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploading}
                data-testid="button-upload-logo"
              >
                <UploadCloud className="mr-2 h-4 w-4" />
                {isUploading ? "Uploading..." : logoUrl ? "Change Logo" : "Upload Logo"}
              </Button>
            </div>
            
            {logoUrl && (
              <Button 
                variant="ghost" 
                className="w-full text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={handleRemove}
                disabled={removeLogo.isPending || isUploading}
                data-testid="button-remove-logo"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Remove Logo
              </Button>
            )}

            <div className="text-xs text-muted-foreground mt-4 space-y-1">
              <p>• Recommended size: 256x256px or larger</p>
              <p>• Supported formats: PNG, JPG, WEBP</p>
              <p>• Transparent background preferred</p>
            </div>
          </div>

        </div>
      </CardContent>
    </Card>
  )
}
