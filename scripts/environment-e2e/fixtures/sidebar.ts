import { expect, type Page } from '@playwright/test'

/** Opens the sidebar's Projects section, which starts collapsed, and leaves it open if it already is. */
export async function openProjectsSection(page: Page) {
  const toggle = page.locator('[data-inbox-section="projects"]').filter({ visible: true }).getByRole('button', { name: 'Projects', exact: true })
  await expect(toggle).toBeVisible()
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
}
