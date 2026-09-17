import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import App from './App'

describe('primary prototype flow', () => {
  beforeEach(() => localStorage.clear())

  it('supports login and starts resume creation', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '提交登录' }))
    fireEvent.click(screen.getByRole('button', { name: '新建简历' }))
    expect(screen.getByDisplayValue('前端开发工程师简历')).toBeInTheDocument()
  })

  it('opens a real quota overlay from the tester controls', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '测试工具' }))
    fireEvent.click(screen.getByRole('button', { name: '模拟额度不足' }))
    expect(screen.getByRole('dialog', { name: '本月 AI 额度已用完' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
