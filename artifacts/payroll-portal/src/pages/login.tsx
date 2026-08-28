import * as React from "react"
import { useLocation } from "wouter"
import { z } from "zod"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Eye, EyeOff, LockKeyhole, UserRound } from "lucide-react"

import { useLogin, useGetMe, getGetMeQueryKey } from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { recordSessionStarted } from "@/lib/session-expiration"
import loginCampusUrl from "@/assets/payroll-login-campus.jpeg"

const SCHOOL_LOGO_URL = "/LOGO N1 New copy.jpg"

const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
})

type LoginFormValues = z.infer<typeof loginSchema>

export default function LoginPage() {
  const [, setLocation] = useLocation()
  const queryClient = useQueryClient()
  const [isPasswordVisible, setIsPasswordVisible] = React.useState(false)
  const [isLogoAvailable, setIsLogoAvailable] = React.useState(true)
  
  // If already logged in, redirect to dashboard
  const { data: user, isLoading: isUserLoading } = useGetMe()
  React.useEffect(() => {
    if (user) setLocation("/")
  }, [user, setLocation])

  const login = useLogin({
    mutation: {
      onSuccess: (data) => {
        recordSessionStarted()
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
    <main
      className="relative grid min-h-[100dvh] place-items-center overflow-x-hidden bg-[#e7eef8] font-['Inter',system-ui,sans-serif] dark:bg-slate-950"
      data-testid="page-login"
    >
      <div
        className="absolute inset-0 bg-cover bg-center opacity-50"
        style={{ backgroundImage: `url(${loginCampusUrl})` }}
        aria-hidden="true"
      />
      <div className="absolute inset-0 hidden bg-slate-950/55 dark:block" aria-hidden="true" />

      <div className="relative z-10 flex w-full max-w-[680px] flex-col items-center px-5 py-8 sm:px-8 sm:py-10">
        <div className="grid w-[92px] shrink-0 place-items-center overflow-hidden rounded-md bg-white shadow-[0_6px_22px_rgba(16,46,94,0.16)] sm:w-[108px]">
          {isLogoAvailable ? (
            <img
              src={SCHOOL_LOGO_URL}
              alt="St. Anthony's Group of Schools logo"
              className="block h-auto w-full object-contain"
              onError={() => setIsLogoAvailable(false)}
            />
          ) : (
            <span className="grid aspect-[10/11] w-full place-items-center text-lg font-extrabold text-teal-700">STA</span>
          )}
        </div>

        <h1 className="mb-6 mt-4 text-center font-serif text-2xl font-bold leading-tight text-[#071f50] drop-shadow-[0_1px_1px_rgba(255,255,255,0.8)] dark:text-blue-50 sm:mb-8 sm:mt-5 sm:text-[2rem]">
          St. Anthony&apos;s Group of Schools
        </h1>

        <section className="w-4/5 max-w-[544px] rounded-[22px] border-2 border-white/80 bg-white/30 p-5 text-[#071f50] shadow-[0_20px_52px_rgba(26,61,110,0.18),inset_0_1px_0_rgba(255,255,255,0.75)] backdrop-blur-xl dark:border-white/20 dark:bg-slate-950/45 dark:text-blue-50 dark:shadow-[0_20px_52px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.12)] sm:p-9">
          <div className="mb-6 text-center sm:mb-8">
            <h2 className="text-[1.625rem] font-bold leading-tight tracking-normal text-[#07245d] dark:text-blue-50 sm:text-[2rem]">
              Payroll Portal
            </h2>
            <div className="mx-auto my-4 flex max-w-[288px] items-center" aria-hidden="true">
              <span className="h-px flex-1 bg-[#7890b8]/35 dark:bg-blue-100/25" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#2675df]" />
              <span className="h-px flex-1 bg-[#7890b8]/35 dark:bg-blue-100/25" />
            </div>
            <p className="text-xs font-medium text-[#63718b] dark:text-blue-100/75 sm:text-sm">
              Secure Access to Payroll Management System
            </p>
          </div>

          <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-4" data-testid="form-login">
            <div className="grid gap-2">
              <Label htmlFor="email" className="text-sm font-semibold text-[#071f50] dark:text-blue-50">Email</Label>
              <div className="relative flex items-center">
                <UserRound className="pointer-events-none absolute left-4 h-5 w-5 text-[#5d6d8d] dark:text-blue-100/70" aria-hidden="true" />
                <Input
                  id="email"
                  type="email"
                  placeholder="Enter your email"
                  autoComplete="email"
                  disabled={login.isPending}
                  data-testid="input-email"
                  className="h-12 rounded-lg border-[#9baac2]/65 bg-white/80 pl-12 pr-4 text-sm text-[#071f50] shadow-sm placeholder:text-[#8491a8] focus-visible:border-[#2675df] focus-visible:bg-white/95 focus-visible:ring-4 focus-visible:ring-blue-500/15 dark:border-white/20 dark:bg-slate-950/65 dark:text-white dark:placeholder:text-blue-100/45 dark:focus-visible:border-blue-300"
                  {...form.register("email")}
                />
              </div>
              {form.formState.errors.email && (
                <p className="text-sm font-medium text-destructive">
                  {form.formState.errors.email.message}
                </p>
              )}
            </div>

            <div className="grid gap-2">
              <Label htmlFor="password" className="text-sm font-semibold text-[#071f50] dark:text-blue-50">Password</Label>
              <div className="relative flex items-center">
                <LockKeyhole className="pointer-events-none absolute left-4 h-5 w-5 text-[#5d6d8d] dark:text-blue-100/70" aria-hidden="true" />
              <Input
                id="password"
                type={isPasswordVisible ? "text" : "password"}
                placeholder="Enter your password"
                autoComplete="current-password"
                disabled={login.isPending}
                data-testid="input-password"
                className="h-12 rounded-lg border-[#9baac2]/65 bg-white/80 pl-12 pr-12 text-sm text-[#071f50] shadow-sm placeholder:text-[#8491a8] focus-visible:border-[#2675df] focus-visible:bg-white/95 focus-visible:ring-4 focus-visible:ring-blue-500/15 dark:border-white/20 dark:bg-slate-950/65 dark:text-white dark:placeholder:text-blue-100/45 dark:focus-visible:border-blue-300"
                {...form.register("password")}
              />
              <button
                type="button"
                onClick={() => setIsPasswordVisible((visible) => !visible)}
                className="absolute right-3 grid h-9 w-9 place-items-center rounded-md text-[#5d6d8d] hover:bg-blue-50 hover:text-[#07245d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:text-blue-100/70 dark:hover:bg-white/10 dark:hover:text-white"
                aria-label={isPasswordVisible ? "Hide password" : "Show password"}
                title={isPasswordVisible ? "Hide password" : "Show password"}
              >
                {isPasswordVisible ? <EyeOff className="h-[18px] w-[18px]" /> : <Eye className="h-[18px] w-[18px]" />}
              </button>
              </div>
              <span className="justify-self-end text-sm font-medium text-[#0752bd] dark:text-blue-300">Forgot password?</span>
              {form.formState.errors.password && (
                <p className="text-sm font-medium text-destructive">
                  {form.formState.errors.password.message}
                </p>
              )}
            </div>

            {login.isError && (
              <div className="rounded-lg border border-red-200/70 bg-red-50/85 p-3 dark:border-red-200/20 dark:bg-red-950/55" data-testid="alert-error">
                <p className="text-sm font-medium text-red-700 dark:text-red-100">
                  Invalid email or password. Please try again.
                </p>
              </div>
            )}

            <Button
              type="submit"
              className="mt-1 h-[52px] w-full rounded-[10px] bg-[linear-gradient(105deg,#185ac2,#041b58)] text-base font-semibold text-white shadow-[0_10px_20px_rgba(8,43,111,0.25)] hover:brightness-110 focus-visible:ring-4 focus-visible:ring-blue-400/30"
              disabled={login.isPending}
              data-testid="button-submit-login"
            >
              <LockKeyhole className="h-5 w-5" />
              {login.isPending ? "Signing in..." : "Sign in"}
            </Button>
          </form>
        </section>
      </div>
    </main>
  )
}
