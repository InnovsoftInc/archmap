resource "azurerm_resource_group" "main" {
  name = "acme"
}

resource "azurerm_linux_web_app" "api" {
  name = "acme-api"
}
