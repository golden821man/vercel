const ora = require('ora')
const { gray } = require('chalk')
const eraseLines = require('./erase-lines')

const wait = msg => {
  const spinner = ora(gray(msg))
  spinner.color = 'gray'
  spinner.start()

  return () => {
    spinner.stop()
    process.stdout.write(eraseLines(1))
  }
}

module.exports = wait
