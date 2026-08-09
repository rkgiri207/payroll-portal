import * as React from "react"
import { useLocation } from "wouter"
import { z } from "zod"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Building2 } from "lucide-react"

import { useLogin, useGetMe, getGetMeQueryKey } from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
})

type LoginFormValues = z.infer<typeof loginSchema>

export default function LoginPage() {
  const [, setLocation] = useLocation()
  const queryClient = useQueryClient()
  
  // If already logged in, redirect to dashboard
  const { data: user, isLoading: isUserLoading } = useGetMe()
  React.useEffect(() => {
    if (user) setLocation("/")
  }, [user, setLocation])

  const login = useLogin({
    mutation: {
      onSuccess: (data) => {
        // Update the cache immediately so next queries know we are logged in
        queryClient.setQueryData(getGetMeQueryKey(), data)
        setLocation("/")
      },
    }
  })

  const form = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: "",
      password: "",
    },
  })

  const onSubmit = (data: LoginFormValues) => {
    login.mutate({ data })
  }

  if (isUserLoading || user) {
    return <div className="min-h-[100dvh] flex items-center justify-center bg-background" />
  }

  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-background p-4" data-testid="page-login">
      <div className="w-full max-w-[400px] space-y-6">
        
        <div className="flex flex-col items-center text-center space-y-2">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary">
            <Building2 className="h-6 w-6 text-primary-foreground" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Payroll Portal</h1>
          <p className="text-sm text-muted-foreground">
            Sign in to your administrative account
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
            <CardDescription>Enter your credentials below to continue</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" data-testid="form-login">
              
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="admin@example.com"
                  autoComplete="email"
                  disabled={login.isPending}
                  data-testid="input-email"
                  {...form.register("email")}
                />
                {form.formState.errors.email && (
                  <p className="text-sm font-medium text-destructive">
                    {form.formState.errors.email.message}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  disabled={login.isPending}
                  data-testid="input-password"
                  {...form.register("password")}
                />
                {form.formState.errors.password && (
                  <p className="text-sm font-medium text-destructive">
                    {form.formState.errors.password.message}
                  </p>
                )}
              </div>

              {login.isError && (
                <div className="rounded-md bg-destructive/10 p-3" data-testid="alert-error">
                  <p className="text-sm font-medium text-destructive">
                    Invalid email or password. Please try again.
                  </p>
                </div>
              )}

              <Button 
                type="submit" 
                className="w-full" 
                disabled={login.isPending}
                data-testid="button-submit-login"
              >
                {login.isPending ? "Signing in..." : "Sign in"}
              </Button>
            </form>
          </CardContent>
        </Card>
        
        <p className="text-center text-xs text-muted-foreground">
          Authorized personnel only. Secure connection.
        </p>
      </div>
    </div>
  )
}
