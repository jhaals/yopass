# Automate generating and retrieving a test secret from Yopass
# Simulates adding a secret in the form field, submitting the Encrypt Message button
# Retrieve secret from Redis cache by browsing to one-time generated URL and compare input and output match

from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

# Set up Chrome options
chrome_options = Options()
chrome_options.add_argument("start-maximized")  # Run headless Chrome
chrome_options.add_argument("disable-infobars")  # Run headless Chrome
chrome_options.add_argument("--disable-exensions")  # Run headless Chrome
chrome_options.add_argument("--disable-dev-shm-usage")  # Run headless Chrome
chrome_options.add_argument("--no-sandbox")  # Run headless Chrome
chrome_options.add_argument("--headless")  # Run headless Chrome

# Set up the ChromeDriver service
service = Service('/usr/local/bin/chromedriver')

# Initialize the WebDriver
driver = webdriver.Chrome(service=service, options=chrome_options)

# Set the URL
url = 'http://yopass'

# Set test secret
test_secret = 'this is a Selenium test secret'

# Open the URL
driver.get(url)
driver.implicitly_wait(30)

# Submit the test secret
testSecret = driver.find_element("name", "secret");
testSecret.send_keys(test_secret);
button = driver.find_element("xpath", "//button[span[text()='Encrypt Message']]")
button.click()

# Get the response text
wait = WebDriverWait(driver, 10)
link_element = wait.until(EC.presence_of_element_located((By.ID, 'root')))
link_element = driver.find_element(By.XPATH, f'//td[contains(text(), "{url}/#/s/")]')
complete_url = link_element.text

# Retrieve the test secret
driver.get(complete_url)
driver.implicitly_wait(60)

secret_element = wait.until(EC.presence_of_element_located((By.ID, 'pre')))

if secret_element.text == test_secret:
    print("PASS")
else:
    print("FAIL")

# Close the WebDriver
driver.quit()
